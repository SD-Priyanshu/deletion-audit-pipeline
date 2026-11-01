import { classifyIntent } from './intent.js';
import { resolveIdentity } from './identity.js';
import { resolveFootprint } from './footprint.js';
import { buildPlan } from './plan.js';
import { loadDeletionRules } from './rules.js';
import { inferResourceStates } from './state.js';

export function auditCase(database, request, rules = loadDeletionRules(database)) {
  const identity = resolveIdentity(database, request);
  const footprint = resolveFootprint(database, request);
  const intent = classifyIntent({
    database,
    request,
    identity,
    resourceIds: footprint.resources.map(({ resource_id }) => resource_id)
  });

  if (intent.intent === 'NOT_APPLICABLE') {
    return { case_id: request.case_id, deletion_status: 'NOT_APPLICABLE', steps: [] };
  }
  if (identity.ambiguous || footprint.ambiguous) {
    throw new Error(`Identity resolution is ambiguous for ${request.case_id}`);
  }
  if (!identity.userId) {
    throw new Error(`Identity could not be resolved for ${request.case_id}`);
  }

  const states = inferResourceStates(database, footprint, request.audit_at);
  const resources = states.map((resource) => {
    const selected = resource.latestContainingSnapshot;
    if (!selected) {
      throw new Error(`No state evidence is available for ${request.case_id}:${resource.resource_id}`);
    }
    return {
      ...resource,
      state: selected.state,
      evidence_id: selected.evidence_id
    };
  });
  const plan = buildPlan(resources, rules);
  return {
    case_id: request.case_id,
    deletion_status: plan.deletion_status,
    steps: plan.steps
  };
}

