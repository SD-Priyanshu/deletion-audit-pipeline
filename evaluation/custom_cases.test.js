import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { resolveIdentity } from '../src/pipeline/identity.js';
import { classifyIntent } from '../src/pipeline/intent.js';
import { buildPlan } from '../src/pipeline/plan.js';

const rules = new Map([
  ['ACCOUNT_TOMBSTONE', 'REDACT'],
  ['ANALYTICS_PROFILE', 'ANONYMIZE'],
  ['BACKUP_ARCHIVE', 'RETAIN'],
  ['DATA_FLOW', 'DATA_FLOW'],
  ['SEARCH_INDEX_ENTRY', 'DELETE'],
  ['SECURITY_AUDIT_LOG', 'RETAIN']
]);

function resource(system_id, resource_id, data_category, state, evidence_id = 'synthetic_evidence') {
  return { system_id, resource_id, data_category, state, evidence_id };
}

describe('author-written custom evaluation cases', () => {
  it('finds an old email hash in a search index after an email change', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE user_identities (
        user_id TEXT, name TEXT, email TEXT, phone TEXT, email_hash TEXT, updated_at TEXT
      );
      CREATE TABLE user_audit_log (
        audit_id TEXT, user_id TEXT, event_time TEXT, field_name TEXT, old_value TEXT, new_value TEXT
      );
    `);
    const currentEmail = 'new-address';
    const oldEmail = 'old-address';
    const hash = (email) => createHash('sha256')
      .update(email.trim().toLowerCase(), 'utf8')
      .digest('hex');
    database.prepare(
      `INSERT INTO user_identities VALUES (?, ?, ?, ?, ?, ?)`
    ).run('synthetic_user', 'Sample Person', currentEmail, '+10000000000', hash(currentEmail), '2026-01-02T00:00:00Z');
    database.prepare(
      `INSERT INTO user_audit_log VALUES (?, ?, ?, ?, ?, ?)`
    ).run('synthetic_audit', 'synthetic_user', '2026-01-02T00:00:00Z', 'email', oldEmail, currentEmail);

    try {
      const identity = resolveIdentity(database, {
        email: oldEmail,
        audit_at: '2026-01-03T00:00:00Z'
      });
      const plan = buildPlan([
        resource('search_service', 'synthetic_index_entry', 'SEARCH_INDEX_ENTRY', 'PRESENT')
      ], rules);
      const actual = {
        resolved_user: identity.userId,
        old_email_hash_found: identity.identifiers.emailHashes.includes(hash(oldEmail)),
        status: plan.deletion_status,
        remediation: plan.steps.find(({ phase }) => phase === 'REMEDIATION')?.operation
      };

      expect(actual).toEqual({
        resolved_user: 'synthetic_user',
        old_email_hash_found: true,
        status: 'INCOMPLETE',
        remediation: 'DELETE_RECORD'
      });
    } finally {
      database.close();
    }
  });

  it('disables an active flow and blocks a restorable backup', () => {
    const plan = buildPlan([
      resource('connector_service', 'synthetic_flow', 'DATA_FLOW', 'ACTIVE'),
      resource('backup_service', 'synthetic_backup', 'BACKUP_ARCHIVE', 'RESTORABLE')
    ], rules);
    const actual = {
      status: plan.deletion_status,
      remediations: plan.steps
        .filter(({ phase }) => phase === 'REMEDIATION')
        .map(({ operation }) => operation)
    };

    expect(actual).toEqual({
      status: 'INCOMPLETE',
      remediations: ['DISABLE_DATA_FLOW', 'BLOCK_RESTORE']
    });
  });

  it('accepts a redacted tombstone with a retained audit record as complete', () => {
    const plan = buildPlan([
      resource('account_service', 'synthetic_tombstone', 'ACCOUNT_TOMBSTONE', 'REDACTED'),
      resource('security_service', 'synthetic_audit_record', 'SECURITY_AUDIT_LOG', 'PRESENT')
    ], rules);
    const actual = {
      status: plan.deletion_status,
      verifications: plan.steps.map(({ operation }) => operation)
    };

    expect(actual).toEqual({
      status: 'COMPLETE',
      verifications: ['VERIFY_RECORD_PRESENT', 'VERIFY_RECORD_REDACTED']
    });
  });

  it('does not treat a non-deletion question containing “delete” as authorization', () => {
    const result = classifyIntent({
      request: {
        email: 'synthetic-address',
        audit_at: '2026-01-03T00:00:00Z',
        request_text: 'Do not delete my account; I only need to know whether the word delete appears in my request.'
      }
    });
    const actual = result.intent;

    expect(actual).toBe('NOT_APPLICABLE');
  });
});
