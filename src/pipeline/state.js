import { filterEvidenceAtOrBefore } from './time.js';

function factStateForSnapshot(facts) {
  if (facts.length === 0) return 'ABSENT';

  const states = facts.map((fact) => fact.state);
  if (states.includes('PRESENT')) return 'PRESENT';
  for (const state of ['ACTIVE', 'RESTORABLE', 'BLOCKED', 'DISABLED', 'ANONYMIZED', 'REDACTED']) {
    if (states.includes(state)) return state;
  }
  if (states.includes('ABSENT')) return 'ABSENT';
  return states[0] ?? 'ABSENT';
}

function latest(rows) {
  return [...rows].sort((left, right) => (
    Date.parse(right.captured_at) - Date.parse(left.captured_at) ||
    right.evidence_id.localeCompare(left.evidence_id)
  ))[0] ?? null;
}

export function inferResourceStates(database, footprint, auditAt) {
  const evidenceRows = database.prepare(
    'SELECT file_id AS evidence_id, captured_at FROM evidence_files'
  ).all();
  const eligibleEvidenceIds = new Set(
    filterEvidenceAtOrBefore(evidenceRows, auditAt).map(({ evidence_id }) => evidence_id)
  );
  const facts = database.prepare(
    `SELECT evidence_id, system_id, resource_id, data_category, state, captured_at, location
     FROM evidence_facts`
  ).all();
  const coverageColumns = database.prepare('PRAGMA table_info(evidence_coverage)').all();
  const hasCoverageTable = coverageColumns.length > 0;
  const coverage = hasCoverageTable
    ? database.prepare(
      'SELECT evidence_id, system_id, captured_at FROM evidence_coverage'
    ).all()
    : facts.map(({ evidence_id, system_id, captured_at }) => ({ evidence_id, system_id, captured_at }));
  const eligibleCoverage = filterEvidenceAtOrBefore(coverage, auditAt);
  const eligibleFacts = filterEvidenceAtOrBefore(facts, auditAt);

  return footprint.resources.map((resource) => {
    const coveringSnapshots = eligibleCoverage.filter((snapshot) => snapshot.system_id === resource.system_id);
    const containingSnapshots = eligibleFacts
      .filter((fact) => fact.system_id === resource.system_id &&
        fact.resource_id === resource.resource_id)
      .map((fact) => ({
        evidence_id: fact.evidence_id,
        system_id: fact.system_id,
        captured_at: fact.captured_at
      }))
      .filter((snapshot, index, rows) => (
        rows.findIndex((candidate) => candidate.evidence_id === snapshot.evidence_id) === index
      ));
    const covering = latest(coveringSnapshots);
    const containing = latest(containingSnapshots);

    function choice(snapshot) {
      if (!snapshot) return null;
      const snapshotFacts = eligibleFacts.filter((fact) => (
        fact.evidence_id === snapshot.evidence_id &&
        fact.system_id === resource.system_id &&
        fact.resource_id === resource.resource_id
      ));
      return {
        evidence_id: snapshot.evidence_id,
        captured_at: snapshot.captured_at,
        state: factStateForSnapshot(snapshotFacts),
        facts: snapshotFacts.map((fact) => ({
          state: fact.state,
          data_category: fact.data_category,
          location: fact.location
        }))
      };
    }

    return {
      ...resource,
      evidence_ids: resource.evidence_ids.filter((evidenceId) => (
        eligibleEvidenceIds.has(evidenceId)
      )),
      latestCoveringSnapshot: choice(covering),
      latestContainingSnapshot: choice(containing ?? covering)
    };
  });
}
