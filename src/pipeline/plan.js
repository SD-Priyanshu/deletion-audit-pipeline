import { orderSteps } from './order.js';
import { requiredActionFor } from './rules.js';

function operationForResource(resource, state, rules) {
  const action = requiredActionFor(resource.data_category, rules);

  if (resource.data_category === 'DATA_FLOW') {
    return state === 'ACTIVE'
      ? {
        needsAction: true,
        finding: ['REPORT_ACTIVE_DATA_FLOW', 'ACTIVE'],
        remediation: ['DISABLE_DATA_FLOW', 'DISABLED'],
        verification: ['VERIFY_DATA_FLOW_DISABLED', 'DISABLED']
      }
      : { needsAction: false, verification: ['VERIFY_DATA_FLOW_DISABLED', 'DISABLED'] };
  }

  if (resource.data_category === 'BACKUP_ARCHIVE') {
    return state === 'RESTORABLE' || state === 'ACTIVE'
      ? {
        needsAction: true,
        finding: ['REPORT_RESTORE_RISK', 'ACTIVE'],
        remediation: ['BLOCK_RESTORE', 'BLOCKED'],
        verification: ['VERIFY_RESTORE_BLOCKED', 'BLOCKED']
      }
      : { needsAction: false, verification: ['VERIFY_RESTORE_BLOCKED', 'BLOCKED'] };
  }

  if (action === 'RETAIN') {
    return { needsAction: false, verification: ['VERIFY_RECORD_PRESENT', 'PRESENT'] };
  }

  if (action === 'DELETE') {
    return state === 'ABSENT'
      ? { needsAction: false, verification: ['VERIFY_RECORD_ABSENT', 'ABSENT'] }
      : {
        needsAction: true,
        finding: ['REPORT_REMAINING_RECORD', 'PRESENT'],
        remediation: ['DELETE_RECORD', 'ABSENT'],
        verification: ['VERIFY_RECORD_ABSENT', 'ABSENT']
      };
  }

  if (action === 'REDACT' || action === 'ANONYMIZE') {
    const target = action === 'REDACT' ? 'REDACTED' : 'ANONYMIZED';
    const verification = state === 'ABSENT'
      ? ['VERIFY_RECORD_ABSENT', 'ABSENT']
      : action === 'REDACT'
        ? ['VERIFY_RECORD_REDACTED', 'REDACTED']
        : ['VERIFY_RECORD_ANONYMIZED', 'ANONYMIZED'];
    return state === 'PRESENT'
      ? {
        needsAction: true,
        finding: ['REPORT_EXPOSED_PII', 'PRESENT'],
        remediation: [`${action}_RECORD`, target],
        verification
      }
      : { needsAction: false, verification };
  }

  throw new Error(`Unsupported required action ${action} for ${resource.data_category}`);
}

function step(phase, resource, operationState, evidenceId) {
  const [operation, state] = operationState;
  return {
    step_no: 0,
    phase,
    system_id: resource.system_id,
    resource_id: resource.resource_id,
    operation,
    state,
    evidence_id: evidenceId
  };
}

export function buildPlan(resources, rules) {
  const deduplicated = new Map();
  const decisions = resources.map((resource) => ({
    resource,
    decision: operationForResource(resource, resource.state, rules)
  }));
  const incomplete = decisions.some(({ decision }) => decision.needsAction);

  for (const { resource, decision } of decisions) {
    const action = decision;
    const phaseSteps = action.needsAction
      ? [
        step('FINDING', resource, action.finding, resource.evidence_id),
        step('REMEDIATION', resource, action.remediation, ''),
        step('VERIFICATION', resource, action.verification, '')
      ]
      : [
        step(
          'VERIFICATION',
          resource,
          action.verification,
          incomplete ? '' : resource.evidence_id
        )
      ];

    for (const item of phaseSteps) {
      const key = `${item.system_id}\u0000${item.resource_id}\u0000${item.operation}`;
      if (!deduplicated.has(key)) deduplicated.set(key, item);
    }
  }

  const ordered = orderSteps([...deduplicated.values()]).map((item, index) => ({
    ...item,
    step_no: index + 1
  }));
  return {
    deletion_status: incomplete ? 'INCOMPLETE' : 'COMPLETE',
    steps: ordered
  };
}
