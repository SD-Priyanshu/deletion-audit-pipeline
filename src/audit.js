import { mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCase } from './pipeline/auditCase.js';
import { loadDeletionRules } from './pipeline/rules.js';
import { validateOutputRows } from './pipeline/validate.js';
import { databasePath, outputPath, samplePredictionPath } from './config.js';
import { assertDatasetAvailable } from './dataset.js';

function csvField(value) {
  const text = String(value ?? '');
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function outputCsv(rows) {
  return [
    'case_id,deletion_status,steps_json',
    ...rows.map((row) => [
      csvField(row.case_id),
      csvField(row.deletion_status),
      csvField(row.steps_json)
    ].join(','))
  ].join('\n') + '\n';
}

function parseArgs(args) {
  if (args.length === 0) return 'full';
  if (args.length === 1 && args[0] === '--sample') return 'sample';
  throw new Error('Usage: node src/audit.js [--sample]');
}

async function main() {
  const mode = parseArgs(process.argv.slice(2));
  assertDatasetAvailable();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = mode === 'sample' ? 'sample_deletion_requests' : 'deletion_requests';
    const requests = database.prepare(
      `SELECT case_id, email, requested_at, audit_at, request_text
       FROM ${table}
       ORDER BY case_id`
    ).all();
    const rules = loadDeletionRules(database);
    const results = [];
    const failures = [];

    for (const request of requests) {
      try {
        const result = auditCase(database, request, rules);
        result.steps_json = JSON.stringify(result.steps);
        delete result.steps;
        results.push(result);
      } catch (error) {
        failures.push({ case_id: request.case_id, reason: error.message });
      }
    }

    const validationFailures = validateOutputRows(
      results,
      mode === 'full' ? 518 : requests.length
    );
    failures.push(...validationFailures);
    const destinationPath = mode === 'sample' ? samplePredictionPath : outputPath;
    if (failures.length === 0) {
      await mkdir(dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, outputCsv(results), 'utf8');
    }

    const statuses = { COMPLETE: 0, INCOMPLETE: 0, NOT_APPLICABLE: 0 };
    for (const result of results) statuses[result.deletion_status] += 1;
    console.log(JSON.stringify({
      statuses,
      validation_failures: failures.slice(0, 20),
      validation_failure_count: failures.length,
      row_count: results.length
    }, null, 2));
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
