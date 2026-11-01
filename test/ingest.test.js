import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { runIngest } from '../src/ingest.js';
import { datasetErrorMessage, isDatasetAvailable } from '../src/dataset.js';

let temporaryDirectory;
const datasetReady = isDatasetAvailable();

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe.skipIf(!datasetReady)(
  datasetReady ? 'dataset ingestion' : datasetErrorMessage(),
  () => {
  it('loads all dataset CSVs using their headers and creates the requested tables', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ghost-data-ingest-'));
    const databasePath = join(temporaryDirectory, 'orchestrate.sqlite');
    const result = await runIngest({ databasePath });
    const database = new DatabaseSync(databasePath);

    try {
      expect(result.csvFiles).toBe(9);
      expect(result.rowCounts.deletion_requests).toBe(518);
      expect(result.rowCounts.user_identities).toBeGreaterThan(0);
      expect(result.rowCounts.user_audit_log).toBeGreaterThan(0);
      expect(result.rowCounts.system_activity).toBeGreaterThan(0);
      expect(result.rowCounts.deletion_rules).toBeGreaterThan(0);
      expect(result.rowCounts.evidence_files).toBeGreaterThan(0);
      expect(result.rowCounts.sample_deletion_requests).toBe(32);
      expect(result.rowCounts.sample_output).toBe(32);
      expect(result.rowCounts.output).toBe(0);

      const activityColumns = database.prepare('PRAGMA table_info(system_activity)').all().map((column) => column.name);
      expect(activityColumns).toEqual([
        'activity_id',
        'event_time',
        'event_type',
        'source_system',
        'target_system',
        'resource_id',
        'reported_result',
        'details'
      ]);

      const requiredTables = new Set(database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      ).all().map((table) => table.name));
      for (const tableName of [
        'evidence_facts',
        'case_identifiers',
        'resource_states',
        'case_results',
        'llm_cache',
        'llm_usage'
      ]) {
        expect(requiredTables.has(tableName)).toBe(true);
      }
    } finally {
      database.close();
    }
  });
});
