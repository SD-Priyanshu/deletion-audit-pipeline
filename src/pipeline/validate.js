import { orderSteps, phaseOrder } from './order.js';

const allowedPairs = new Map([
  ['FINDING:REPORT_REMAINING_RECORD', 'PRESENT'],
  ['FINDING:REPORT_EXPOSED_PII', 'PRESENT'],
  ['FINDING:REPORT_ACTIVE_DATA_FLOW', 'ACTIVE'],
  ['FINDING:REPORT_RESTORE_RISK', 'ACTIVE'],
  ['REMEDIATION:DISABLE_DATA_FLOW', 'DISABLED'],
  ['REMEDIATION:BLOCK_RESTORE', 'BLOCKED'],
  ['REMEDIATION:DELETE_RECORD', 'ABSENT'],
  ['REMEDIATION:REDACT_RECORD', 'REDACTED'],
  ['REMEDIATION:ANONYMIZE_RECORD', 'ANONYMIZED'],
  ['VERIFICATION:VERIFY_RECORD_ABSENT', 'ABSENT'],
  ['VERIFICATION:VERIFY_RECORD_PRESENT', 'PRESENT'],
  ['VERIFICATION:VERIFY_RECORD_REDACTED', 'REDACTED'],
  ['VERIFICATION:VERIFY_RECORD_ANONYMIZED', 'ANONYMIZED'],
  ['VERIFICATION:VERIFY_DATA_FLOW_DISABLED', 'DISABLED'],
  ['VERIFICATION:VERIFY_RESTORE_BLOCKED', 'BLOCKED']
]);

function fail(caseId, reason) {
  return { case_id: caseId ?? '(missing)', reason };
}

export function validateCaseResult(result) {
  const failures = [];
  if (!result || !['COMPLETE', 'INCOMPLETE', 'NOT_APPLICABLE'].includes(result.deletion_status)) {
    return [fail(result?.case_id, 'invalid deletion_status')];
  }
  let steps;
  try {
    steps = typeof result.steps_json === 'string'
      ? JSON.parse(result.steps_json)
      : result.steps;
  } catch {
    return [fail(result.case_id, 'steps_json does not parse as JSON')];
  }
  if (!Array.isArray(steps)) return [fail(result.case_id, 'steps_json must be an array')];
  if (result.deletion_status === 'NOT_APPLICABLE' && steps.length !== 0) {
    failures.push(fail(result.case_id, 'NOT_APPLICABLE must have no steps'));
  }

  const keys = new Set();
  for (const [index, item] of steps.entries()) {
    const fields = Object.keys(item).sort();
    if (fields.join(',') !== 'evidence_id,operation,phase,resource_id,state,step_no,system_id') {
      failures.push(fail(result.case_id, `step ${index + 1}: unexpected or missing fields`));
    }
    if (item.step_no !== index + 1) failures.push(fail(result.case_id, `step ${index + 1}: non-consecutive step_no`));
    if (!phaseOrder.includes(item.phase)) failures.push(fail(result.case_id, `step ${index + 1}: invalid phase`));
    const expectedState = allowedPairs.get(`${item.phase}:${item.operation}`);
    if (!expectedState) failures.push(fail(result.case_id, `step ${index + 1}: operation not allowed for phase`));
    else if (item.state !== expectedState) failures.push(fail(result.case_id, `step ${index + 1}: state does not match operation`));
    if (typeof item.system_id !== 'string' || !item.system_id ||
        typeof item.resource_id !== 'string' || !item.resource_id) {
      failures.push(fail(result.case_id, `step ${index + 1}: missing system_id or resource_id`));
    }
    if (typeof item.evidence_id !== 'string') {
      failures.push(fail(result.case_id, `step ${index + 1}: evidence_id must be a string`));
    }
    const key = `${item.system_id}\u0000${item.resource_id}\u0000${item.operation}`;
    if (keys.has(key)) failures.push(fail(result.case_id, `step ${index + 1}: duplicate resource operation`));
    keys.add(key);

    if (result.deletion_status === 'COMPLETE') {
      if (item.phase !== 'VERIFICATION') {
        failures.push(fail(result.case_id, `step ${index + 1}: COMPLETE may contain only verification`));
      } else if (!item.evidence_id) {
        failures.push(fail(result.case_id, `step ${index + 1}: COMPLETE verification needs evidence_id`));
      }
    }
    if (result.deletion_status === 'INCOMPLETE') {
      if (item.phase === 'FINDING' && !item.evidence_id) {
        failures.push(fail(result.case_id, `step ${index + 1}: finding needs evidence_id`));
      }
      if (item.phase === 'REMEDIATION' && item.evidence_id !== '') {
        failures.push(fail(result.case_id, `step ${index + 1}: remediation evidence_id must be empty`));
      }
      if (item.phase === 'VERIFICATION' && item.evidence_id !== '') {
        failures.push(fail(result.case_id, `step ${index + 1}: INCOMPLETE verification evidence_id must be empty`));
      }
    }
  }

  const phaseRanks = steps.map((item) => phaseOrder.indexOf(item.phase));
  if (phaseRanks.some((rank, index) => index > 0 && rank < phaseRanks[index - 1])) {
    failures.push(fail(result.case_id, 'steps are not ordered by phase'));
  }
  const sorted = orderSteps(steps);
  if (sorted.some((item, index) => item !== steps[index])) {
    failures.push(fail(result.case_id, 'steps are not ordered by operation, system_id, and resource_id'));
  }
  return failures;
}

export function validateOutputRows(rows, expectedCount = null) {
  const failures = [];
  if (expectedCount !== null && rows.length !== expectedCount) {
    failures.push(fail('(output)', `expected ${expectedCount} rows; got ${rows.length}`));
  }
  const seen = new Set();
  let previousCaseId = null;
  for (const row of rows) {
    if (seen.has(row.case_id)) failures.push(fail(row.case_id, 'duplicate case_id'));
    seen.add(row.case_id);
    if (previousCaseId !== null && row.case_id < previousCaseId) {
      failures.push(fail(row.case_id, 'rows are not sorted by case_id'));
    }
    previousCaseId = row.case_id;
    failures.push(...validateCaseResult(row));
  }
  return failures;
}
