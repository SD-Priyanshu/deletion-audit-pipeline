import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { runEvidenceExtraction } from '../src/evidence/extract.js';
import { resolveFootprint } from '../src/pipeline/footprint.js';
import { isAtOrBefore } from '../src/pipeline/time.js';
import { databasePath as sourceDatabasePath, datasetDirectory } from '../src/config.js';
import { datasetErrorMessage, isDatasetAvailable } from '../src/dataset.js';
import { existsSync } from 'node:fs';

const datasetReady = isDatasetAvailable() && existsSync(sourceDatabasePath);
const datasetSkipReason = isDatasetAvailable()
  ? 'Run npm run ingest before dataset-backed tests.'
  : datasetErrorMessage();
let temporaryDirectory;

function collectDataStores(value, stores = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectDataStores(item, stores);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key.toLowerCase().replace(/[^a-z0-9]/gu, '') === 'datastore' &&
          typeof child === 'string' && child.trim() !== '') {
        stores.push(child.trim());
      }
      if (child && typeof child === 'object') collectDataStores(child, stores);
    }
  }
  return stores;
}

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe.skipIf(!datasetReady)(datasetSkipReason, () => {
describe('evidence extraction recall', () => {
  it('checks sample citations against facts or covering-snapshot absence', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ghost-evidence-recall-'));
    const databasePath = join(temporaryDirectory, 'orchestrate.sqlite');
    await copyFile(sourceDatabasePath, databasePath);
    await runEvidenceExtraction({
      databasePath,
      datasetDirectory,
      output: { log() {} }
    });

    const database = new DatabaseSync(databasePath, { readOnly: true });
    const expectedStateByOperation = {
      REPORT_EXPOSED_PII: 'PRESENT',
      REPORT_REMAINING_RECORD: 'PRESENT',
      REPORT_RESTORE_RISK: ['ACTIVE', 'RESTORABLE'],
      REPORT_ACTIVE_DATA_FLOW: 'ACTIVE',
      VERIFY_RECORD_ABSENT: 'ABSENT',
      VERIFY_RECORD_PRESENT: 'PRESENT',
      VERIFY_RECORD_REDACTED: 'REDACTED',
      VERIFY_RECORD_ANONYMIZED: 'ANONYMIZED',
      VERIFY_DATA_FLOW_DISABLED: 'DISABLED',
      VERIFY_RESTORE_BLOCKED: 'BLOCKED'
    };

    try {
      const rows = database.prepare(
        'SELECT case_id, steps_json FROM sample_output ORDER BY case_id'
      ).all();
      expect(rows).toHaveLength(32);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM evidence_facts WHERE data_category = 'DATA_FLOW' AND state = 'ACTIVE'"
      ).get().count).toBeGreaterThan(0);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM evidence_facts WHERE data_category = 'DATA_FLOW' AND state = 'DISABLED'"
      ).get().count).toBeGreaterThan(0);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM evidence_facts WHERE data_category = 'BACKUP_ARCHIVE' AND state = 'RESTORABLE'"
      ).get().count).toBeGreaterThan(0);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM evidence_facts WHERE data_category = 'BACKUP_ARCHIVE' AND state = 'BLOCKED'"
      ).get().count).toBeGreaterThan(0);
      const pdfFacts = database.prepare(
        `SELECT fact_json, identifiers
         FROM evidence_facts AS facts
         JOIN evidence_files AS files ON files.file_id = facts.evidence_id
         WHERE lower(files.file_path) LIKE '%.pdf'`
      ).all().map(({ fact_json, identifiers }) => ({
        record: JSON.parse(fact_json),
        identifiers: JSON.parse(identifiers)
      }));
      expect(pdfFacts.some(({ record }) => record.attachment_indicator === true &&
        typeof record.uploaded_file === 'string')).toBe(true);
      expect(pdfFacts.some(({ record }) => typeof record.retention_until === 'string')).toBe(true);
      expect(pdfFacts.some(({ identifiers }) => (
        typeof identifiers.name === 'string' ||
        typeof identifiers.user_id === 'string' ||
        (Array.isArray(identifiers.order_references) && identifiers.order_references.length > 0)
      ))).toBe(true);

      const knownSystems = new Set(database.prepare(
        `SELECT source_system AS system_id FROM system_activity
         UNION SELECT target_system AS system_id FROM system_activity`
      ).all().map(({ system_id }) => system_id));
      const jsonManifests = database.prepare(
        `SELECT file_id, file_path FROM evidence_files
         WHERE lower(file_path) LIKE '%.json'`
      ).all();
      let foundScopedDataStore = false;
      for (const manifest of jsonManifests) {
        const content = await readFile(resolve(datasetDirectory, manifest.file_path), 'utf8');
        for (const systemId of collectDataStores(JSON.parse(content))) {
          if (!knownSystems.has(systemId)) continue;
          foundScopedDataStore = true;
          expect(database.prepare(
            'SELECT 1 FROM evidence_coverage WHERE evidence_id = ? AND system_id = ?'
          ).get(manifest.file_id, systemId)).toBeTruthy();
        }
      }
      expect(foundScopedDataStore).toBe(true);

      const replicaGhost = database.prepare(
        `SELECT replica.evidence_id, replica.system_id, replica.resource_id
         FROM evidence_facts AS replica
         JOIN evidence_facts AS primary_fact
           ON primary_fact.evidence_id = replica.evidence_id
          AND primary_fact.system_id = replica.system_id
          AND primary_fact.resource_id = replica.resource_id
          AND primary_fact.state = 'ABSENT'
         WHERE replica.state = 'PRESENT'
           AND replica.location LIKE '%replica%'
         LIMIT 1`
      ).get();
      expect(replicaGhost).toBeTruthy();

      const mismatchesByEvidenceId = {};
      const inferredAbsencesByEvidenceId = {};
      const unlinkedSampleResources = [];
      const falsePositives = [];
      const expectedResourcePairs = new Set();
      const linkedResourcePairs = new Set();

      for (const row of rows) {
        const steps = JSON.parse(row.steps_json);
        const request = database.prepare(
          'SELECT case_id, email, audit_at FROM sample_deletion_requests WHERE case_id = ?'
        ).get(row.case_id);
        const footprint = resolveFootprint(database, request);
        const linkedResources = new Set(footprint.resources.map((resource) => (
          `${resource.system_id}\u0000${resource.resource_id}`
        )));
        const expectedResources = new Set(
          steps.filter((step) => ['FINDING', 'VERIFICATION'].includes(step.phase))
            .map((step) => `${step.system_id}\u0000${step.resource_id}`)
        );
        for (const resourceKey of expectedResources) {
          const pairKey = `${row.case_id}\u0000${resourceKey}`;
          expectedResourcePairs.add(pairKey);
          if (linkedResources.has(resourceKey)) linkedResourcePairs.add(pairKey);
        }
        for (const resource of footprint.resources) {
          const resourceKey = `${resource.system_id}\u0000${resource.resource_id}`;
          if (expectedResources.has(resourceKey)) continue;
          falsePositives.push({
            case_id: row.case_id,
            system_id: resource.system_id,
            resource_id: resource.resource_id,
            evidence_ids: resource.evidence_ids,
            link_sources: resource.link_sources
          });
        }
        for (const step of steps) {
          if (!['FINDING', 'VERIFICATION'].includes(step.phase)) continue;
          if (!step.evidence_id) continue;
          const resourceKey = `${step.system_id}\u0000${step.resource_id}`;
          if (!linkedResources.has(resourceKey)) {
            unlinkedSampleResources.push({
              case_id: row.case_id,
              evidence_id: step.evidence_id,
              system_id: step.system_id,
              resource_id: step.resource_id
            });
          }
          const expectedState = expectedStateByOperation[step.operation];
          if (!expectedState) continue;
          const acceptedStates = Array.isArray(expectedState) ? expectedState : [expectedState];

          let supported = acceptedStates.some((state) => database.prepare(
            `SELECT 1 FROM evidence_facts
             WHERE evidence_id = ? AND system_id = ? AND resource_id = ? AND state = ?
             LIMIT 1`
          ).get(step.evidence_id, step.system_id, step.resource_id, state));
          if (!supported && step.state === 'ABSENT') {
            const coveringSnapshot = database.prepare(
              'SELECT captured_at FROM evidence_coverage WHERE evidence_id = ? AND system_id = ?'
            ).get(step.evidence_id, step.system_id);
            if (coveringSnapshot && isAtOrBefore(coveringSnapshot.captured_at, request.audit_at)) {
              supported = true;
              (inferredAbsencesByEvidenceId[step.evidence_id] ??= []).push({
                case_id: row.case_id,
                system_id: step.system_id,
                resource_id: step.resource_id
              });
            }
          }
          const expectedStepState = Array.isArray(expectedState) ? 'ACTIVE' : expectedState;
          if (!supported || step.state !== expectedStepState) {
            (mismatchesByEvidenceId[step.evidence_id] ??= []).push({
              case_id: row.case_id,
              system_id: step.system_id,
              resource_id: step.resource_id,
              operation: step.operation,
              step_state: step.state,
              expected_state: expectedStepState,
              fact_found: Boolean(supported)
            });
          }
        }
      }

      console.info('Sample resources without an exact identity/activity link:', JSON.stringify(unlinkedSampleResources, null, 2));
      console.info('Missing fact rows supported by covering-snapshot absence inference:', JSON.stringify(inferredAbsencesByEvidenceId, null, 2));
      console.info(`Exact-link coverage: ${linkedResourcePairs.size}/${expectedResourcePairs.size} sample case/resource pairs`);
      console.info('Footprint resources absent from the sample output:', JSON.stringify(falsePositives, null, 2));
      console.info('Sample evidence recall mismatches grouped by evidence_id:', JSON.stringify(mismatchesByEvidenceId, null, 2));
      expect(linkedResourcePairs.size).toBeGreaterThan(76);
      expect(falsePositives).toEqual([]);
      expect(mismatchesByEvidenceId).toEqual({});
    } finally {
      database.close();
    }
  });
});
});
