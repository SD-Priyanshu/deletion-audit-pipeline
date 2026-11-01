export const phaseOrder = ['FINDING', 'REMEDIATION', 'VERIFICATION'];

const operationsByPhase = {
  FINDING: [
    'REPORT_REMAINING_RECORD',
    'REPORT_EXPOSED_PII',
    'REPORT_ACTIVE_DATA_FLOW',
    'REPORT_RESTORE_RISK'
  ],
  REMEDIATION: [
    'DISABLE_DATA_FLOW',
    'BLOCK_RESTORE',
    'DELETE_RECORD',
    'REDACT_RECORD',
    'ANONYMIZE_RECORD'
  ],
  VERIFICATION: [
    'VERIFY_RECORD_ABSENT',
    'VERIFY_RECORD_PRESENT',
    'VERIFY_RECORD_REDACTED',
    'VERIFY_RECORD_ANONYMIZED',
    'VERIFY_DATA_FLOW_DISABLED',
    'VERIFY_RESTORE_BLOCKED'
  ]
};

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function orderSteps(steps) {
  const phaseRanks = new Map(phaseOrder.map((phase, index) => [phase, index]));
  return [...steps].sort((left, right) => (
    phaseRanks.get(left.phase) - phaseRanks.get(right.phase) ||
    operationsByPhase[left.phase].indexOf(left.operation) -
      operationsByPhase[right.phase].indexOf(right.operation) ||
    compareAscii(left.system_id, right.system_id) ||
    compareAscii(left.resource_id, right.resource_id)
  ));
}

