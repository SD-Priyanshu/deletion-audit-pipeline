import { readdir, mkdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import pino from 'pino';
import { z } from 'zod';
import {
  databasePath as defaultDatabasePath,
  datasetDirectory as defaultDatasetDirectory,
  projectRoot
} from './config.js';
import { assertDatasetAvailable, DatasetNotFoundError } from './dataset.js';

const logger = pino({ name: 'dataset-ingest' });

const tableColumns = {
  deletion_requests: ['case_id', 'email', 'requested_at', 'reported_status', 'reported_at', 'audit_at', 'request_text'],
  user_identities: ['user_id', 'name', 'email', 'phone', 'email_hash', 'updated_at'],
  user_audit_log: ['audit_id', 'user_id', 'event_time', 'field_name', 'old_value', 'new_value'],
  system_activity: ['activity_id', 'event_time', 'event_type', 'source_system', 'target_system', 'resource_id', 'reported_result', 'details'],
  deletion_rules: ['rule_id', 'data_category', 'condition', 'required_action'],
  evidence_files: ['file_id', 'file_path', 'origin', 'captured_at']
};

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function toTableName(csvPath) {
  const baseName = csvPath.slice(0, -extname(csvPath).length);
  const tableName = baseName.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
  if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) {
    throw new Error(`Cannot derive a valid SQLite table name from ${csvPath}`);
  }
  return tableName;
}

async function findCsvFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findCsvFiles(path));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.csv') {
      files.push(path);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function getTableColumns(database, tableName) {
  return database.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map((column) => column.name);
}

function createTableFromHeader(database, tableName, headers) {
  const definitions = headers.map((header) => `${quoteIdentifier(header)} TEXT`).join(', ');
  database.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (${definitions})`);
}

function validateHeaders(tableName, headers) {
  const headerSchema = z.array(z.string().min(1)).min(1);
  const result = headerSchema.safeParse(headers);
  if (!result.success) {
    throw new Error(`CSV for ${tableName} has an empty or missing header`);
  }
  if (new Set(headers).size !== headers.length) {
    throw new Error(`CSV for ${tableName} contains duplicate headers`);
  }
  const expected = tableColumns[tableName];
  if (expected && (headers.length !== expected.length || expected.some((header, index) => headers[index] !== header))) {
    throw new Error(`CSV headers do not match the schema for ${tableName}`);
  }
}

function insertCsvRows(database, tableName, headers, records) {
  const existingColumns = getTableColumns(database, tableName);
  if (existingColumns.length !== headers.length || headers.some((header, index) => header !== existingColumns[index])) {
    throw new Error(`CSV headers do not match the SQLite table ${tableName}`);
  }

  const rowSchema = z.object(Object.fromEntries(headers.map((header) => [header, z.string()]))).strict();
  const placeholders = headers.map(() => '?').join(', ');
  const statement = database.prepare(
    `INSERT INTO ${quoteIdentifier(tableName)} (${headers.map(quoteIdentifier).join(', ')}) VALUES (${placeholders})`
  );
  for (const record of records) {
    const validatedRecord = rowSchema.parse(record);
    statement.run(...headers.map((header) => validatedRecord[header]));
  }
}

export async function runIngest({
  datasetDirectory = defaultDatasetDirectory,
  databasePath = defaultDatabasePath,
  schemaPath = join(projectRoot, 'src', 'db', 'schema.sql')
} = {}) {
  assertDatasetAvailable(datasetDirectory);
  const csvFiles = await findCsvFiles(datasetDirectory);

  const imports = [];
  const seenTables = new Set();
  for (const csvPath of csvFiles) {
    const relativePath = relative(datasetDirectory, csvPath);
    const tableName = toTableName(relativePath);
    if (seenTables.has(tableName)) {
      throw new Error(`Multiple CSV paths map to the SQLite table ${tableName}`);
    }
    seenTables.add(tableName);

    const content = await readFile(csvPath, 'utf8');
    const parsedRows = parse(content, {
      bom: true,
      skip_empty_lines: true
    });
    const headers = parsedRows.shift();
    validateHeaders(tableName, headers);
    const records = parsedRows.map((row, rowIndex) => {
      if (row.length !== headers.length) {
        throw new Error(`CSV row ${rowIndex + 2} in ${relativePath} has an unexpected number of columns`);
      }
      return Object.fromEntries(headers.map((header, index) => [header, row[index]]));
    });
    imports.push({ tableName, headers, records, relativePath });
  }

  await mkdir(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(await readFile(schemaPath, 'utf8'));
    for (const { tableName, headers } of imports) {
      createTableFromHeader(database, tableName, headers);
    }

    database.exec('BEGIN');
    try {
      for (const { tableName } of imports) {
        database.exec(`DELETE FROM ${quoteIdentifier(tableName)}`);
      }
      for (const { tableName, headers, records } of imports) {
        insertCsvRows(database, tableName, headers, records);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    const rowCounts = Object.fromEntries(imports.map(({ tableName }) => [
      tableName,
      database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get().count
    ]));
    logger.info({ databasePath, csvFiles: imports.length, rowCounts }, 'Dataset CSV ingestion complete');
    return { databasePath, csvFiles: imports.length, rowCounts };
  } finally {
    database.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runIngest().catch((error) => {
    if (error instanceof DatasetNotFoundError) {
      console.error(error.message);
    } else {
      logger.error({ err: error }, 'Dataset CSV ingestion failed');
    }
    process.exitCode = 1;
  });
}
