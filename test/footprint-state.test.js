import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { resolveFootprint } from '../src/pipeline/footprint.js';
import { inferResourceStates } from '../src/pipeline/state.js';

function createFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE user_identities (
      user_id TEXT, name TEXT, email TEXT, phone TEXT, email_hash TEXT, updated_at TEXT
    );
    CREATE TABLE evidence_files (
      file_id TEXT, file_path TEXT, origin TEXT, captured_at TEXT
    );
    CREATE TABLE user_audit_log (
      audit_id TEXT, user_id TEXT, event_time TEXT, field_name TEXT, old_value TEXT, new_value TEXT
    );
    CREATE TABLE deletion_rules (
      rule_id TEXT, data_category TEXT, condition TEXT, required_action TEXT
    );
    CREATE TABLE evidence_facts (
      fact_id INTEGER PRIMARY KEY, case_id TEXT, user_id TEXT, resource_id TEXT,
      system_id TEXT, data_category TEXT, state TEXT, evidence_id TEXT,
      captured_at TEXT, fact_json TEXT, location TEXT, identifiers TEXT
    );
    CREATE TABLE evidence_coverage (
      coverage_id INTEGER PRIMARY KEY, evidence_id TEXT, system_id TEXT, captured_at TEXT
    );
    CREATE TABLE system_activity (
      activity_id TEXT, event_time TEXT, event_type TEXT, source_system TEXT,
      target_system TEXT, resource_id TEXT, reported_result TEXT, details TEXT
    );
  `);
  database.prepare(
    'INSERT INTO user_identities VALUES (?, ?, ?, ?, ?, ?)'
  ).run('fixture_user', 'Fixture User', 'fixture-address', null, null, '2026-05-01T00:00:00Z');
  const addEvidence = database.prepare(
    'INSERT INTO evidence_files (file_id, file_path, origin, captured_at) VALUES (?, ?, ?, ?)'
  );
  addEvidence.run('evidence_old', 'old.csv', 'fixture', '2026-05-01T00:00:00Z');
  addEvidence.run('evidence_at_cutoff', 'cutoff.csv', 'fixture', '2026-05-02T00:00:00Z');
  addEvidence.run('evidence_after_cutoff', 'future.csv', 'fixture', '2026-05-02T00:00:01Z');
  database.prepare(
    'INSERT INTO deletion_rules VALUES (?, ?, ?, ?)'
  ).run('fixture_rule', 'DATA_FLOW', 'Enabled connector', 'DISABLE');
  const addCoverage = database.prepare(
    'INSERT INTO evidence_coverage (evidence_id, system_id, captured_at) VALUES (?, ?, ?)'
  );
  addCoverage.run('evidence_old', 'analytics_platform', '2026-05-01T00:00:00Z');
  addCoverage.run('evidence_at_cutoff', 'analytics_platform', '2026-05-02T00:00:00Z');
  addCoverage.run('evidence_after_cutoff', 'analytics_platform', '2026-05-02T00:00:01Z');

  const addFact = database.prepare(
    `INSERT INTO evidence_facts
     (resource_id, system_id, data_category, state, evidence_id, captured_at, identifiers)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  addFact.run(
    'analytics_fixture', 'analytics_platform', 'ANALYTICS_PROFILE', 'PRESENT',
    'evidence_old', '2026-05-01T00:00:00Z',
    JSON.stringify({ email: 'fixture-address', phone: null, email_hash: null, user_id: 'fixture_user' })
  );
  addFact.run(
    'analytics_fixture', 'analytics_platform', 'ANALYTICS_PROFILE', 'PRESENT',
    'evidence_after_cutoff', '2026-05-02T00:00:01Z',
    JSON.stringify({ email: 'fixture-address', phone: null, email_hash: null, user_id: 'fixture_user' })
  );

  const addActivity = database.prepare(
    `INSERT INTO system_activity
     (activity_id, event_time, event_type, source_system, target_system, resource_id, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  addActivity.run(
    'fixture_link', '2026-05-02T00:00:00Z', 'CHECK_RECORD',
    'analytics_platform', 'analytics_platform', 'analytics_fixture',
    'Catalog link for fixture-address'
  );
  addActivity.run(
    'fixture_late_link', '2026-05-02T00:00:01Z', 'CHECK_RECORD',
    'analytics_platform', 'analytics_platform', 'analytics_fixture',
    'Catalog link for fixture-address'
  );
  addActivity.run(
    'fixture_unlinked_activity', '2026-05-02T00:00:00Z', 'LINK_RESOURCE_IDENTITY',
    'data_catalog', 'integration_service', 'data_flow_fixture',
    'Catalog link for fixture-address'
  );
  addActivity.run(
    'fixture_similar_link', '2026-05-02T00:00:00Z', 'LINK_RESOURCE_IDENTITY',
    'data_catalog', 'integration_service', 'data_flow_similar',
    'Catalog link for xfixture-address'
  );
  return database;
}

describe('resource footprint and state inference', () => {
  it('uses exact identity and activity links at the inclusive audit cutoff', () => {
    const database = createFixture();
    try {
      const footprint = resolveFootprint(database, {
        email: 'fixture-address',
        audit_at: '2026-05-02T00:00:00Z'
      });
      expect(footprint.resources.map(({ resource_id }) => resource_id)).toEqual(['analytics_fixture']);
      expect(footprint.resources[0].link_sources)
        .toContain('evidence_identifier');
      expect(footprint.resources[0].activity_ids).toEqual(['fixture_link']);
      expect(footprint.resources[0].evidence_ids).toContain('evidence_after_cutoff');

      const [state] = inferResourceStates(database, footprint, '2026-05-02T00:00:00Z');
      expect(state.evidence_ids).toContain('evidence_old');
      expect(state.evidence_ids).not.toContain('evidence_after_cutoff');
      expect(state.latestContainingSnapshot).toMatchObject({
        evidence_id: 'evidence_old',
        state: 'PRESENT'
      });
    } finally {
      database.close();
    }
  });

  it('compares latest covering versus latest containing snapshots with inclusive cutoffs', () => {
    const database = createFixture();
    try {
      const footprint = resolveFootprint(database, {
        email: 'fixture-address',
        audit_at: '2026-05-02T00:00:00Z'
      });
      const [resource] = inferResourceStates(database, footprint, '2026-05-02T00:00:00Z');
      expect(resource.latestCoveringSnapshot).toMatchObject({
        evidence_id: 'evidence_at_cutoff',
        state: 'ABSENT'
      });
      expect(resource.latestContainingSnapshot).toMatchObject({
        evidence_id: 'evidence_old',
        state: 'PRESENT'
      });
    } finally {
      database.close();
    }
  });

  it('uses the latest explicit resource fact even when that fact is ABSENT', () => {
    const database = createFixture();
    try {
      database.prepare(
        `INSERT INTO evidence_facts
         (resource_id, system_id, data_category, state, evidence_id, captured_at, identifiers)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'analytics_fixture', 'analytics_platform', 'ANALYTICS_PROFILE', 'ABSENT',
        'evidence_at_cutoff', '2026-05-02T00:00:00Z',
        JSON.stringify({ email: null, phone: null, email_hash: null, user_id: null })
      );
      const footprint = resolveFootprint(database, {
        email: 'fixture-address',
        audit_at: '2026-05-02T00:00:00Z'
      });
      const [resource] = inferResourceStates(database, footprint, '2026-05-02T00:00:00Z');

      expect(resource.latestContainingSnapshot).toMatchObject({
        evidence_id: 'evidence_at_cutoff',
        state: 'ABSENT'
      });
    } finally {
      database.close();
    }
  });
});
