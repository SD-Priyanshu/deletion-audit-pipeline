import { describe, expect, it } from 'vitest';
import { buildPlan } from '../src/pipeline/plan.js';
import { validateCaseResult, validateOutputRows } from '../src/pipeline/validate.js';

const rules = new Map([
  ['USER_PROFILE', 'DELETE'],
  ['SUPPORT_MESSAGE', 'REDACT'],
  ['SECURITY_AUDIT_LOG', 'RETAIN'],
  ['BACKUP_ARCHIVE', 'RETAIN']
]);

describe('audit plan and output validation', () => {
  it('plans an incomplete delete, redaction, retained audit, and blocked backup in phase order', () => {
    const { deletion_status, steps } = buildPlan([
      { system_id: 'account_service', resource_id: 'fixture_account', data_category: 'USER_PROFILE', state: 'PRESENT', evidence_id: 'evidence_fixture' },
      { system_id: 'support_platform', resource_id: 'fixture_message', data_category: 'SUPPORT_MESSAGE', state: 'PRESENT', evidence_id: 'evidence_fixture' },
      { system_id: 'security_service', resource_id: 'fixture_audit', data_category: 'SECURITY_AUDIT_LOG', state: 'PRESENT', evidence_id: 'evidence_fixture' },
      { system_id: 'backup_service', resource_id: 'fixture_backup', data_category: 'BACKUP_ARCHIVE', state: 'RESTORABLE', evidence_id: 'evidence_fixture' }
    ], rules);

    expect(deletion_status).toBe('INCOMPLETE');
    expect(steps.map(({ phase, operation }) => `${phase}:${operation}`)).toEqual([
      'FINDING:REPORT_REMAINING_RECORD',
      'FINDING:REPORT_EXPOSED_PII',
      'FINDING:REPORT_RESTORE_RISK',
      'REMEDIATION:BLOCK_RESTORE',
      'REMEDIATION:DELETE_RECORD',
      'REMEDIATION:REDACT_RECORD',
      'VERIFICATION:VERIFY_RECORD_ABSENT',
      'VERIFICATION:VERIFY_RECORD_PRESENT',
      'VERIFICATION:VERIFY_RECORD_REDACTED',
      'VERIFICATION:VERIFY_RESTORE_BLOCKED'
    ]);
    expect(steps.filter(({ phase }) => phase !== 'FINDING').every(({ evidence_id }) => evidence_id === '')).toBe(true);
    expect(validateCaseResult({
      case_id: 'fixture_case',
      deletion_status,
      steps_json: JSON.stringify(steps)
    })).toEqual([]);
  });

  it('verifies compliant resources only and requires cited evidence for complete results', () => {
    const plan = buildPlan([
      { system_id: 'account_service', resource_id: 'fixture_account', data_category: 'USER_PROFILE', state: 'ABSENT', evidence_id: 'evidence_fixture' },
      { system_id: 'security_service', resource_id: 'fixture_audit', data_category: 'SECURITY_AUDIT_LOG', state: 'PRESENT', evidence_id: 'evidence_fixture' }
    ], rules);

    expect(plan.deletion_status).toBe('COMPLETE');
    expect(plan.steps.every(({ phase, evidence_id }) => phase === 'VERIFICATION' && evidence_id)).toBe(true);
    expect(validateOutputRows([{
      case_id: 'fixture_case',
      deletion_status: plan.deletion_status,
      steps_json: JSON.stringify(plan.steps)
    }], 1)).toEqual([]);
  });

  it('rejects invalid evidence references and unsorted full output rows', () => {
    expect(validateCaseResult({
      case_id: 'fixture_case',
      deletion_status: 'COMPLETE',
      steps: [{
        step_no: 1,
        phase: 'VERIFICATION',
        system_id: 'account_service',
        resource_id: 'fixture_account',
        operation: 'VERIFY_RECORD_ABSENT',
        state: 'ABSENT',
        evidence_id: ''
      }]
    })).toContainEqual({
      case_id: 'fixture_case',
      reason: 'step 1: COMPLETE verification needs evidence_id'
    });
    expect(validateOutputRows([
      { case_id: 'fixture_2', deletion_status: 'NOT_APPLICABLE', steps_json: '[]' },
      { case_id: 'fixture_1', deletion_status: 'NOT_APPLICABLE', steps_json: '[]' }
    ], 2)).toContainEqual({
      case_id: 'fixture_1',
      reason: 'rows are not sorted by case_id'
    });
  });
});

