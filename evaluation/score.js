import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'csv-parse/sync';

import { datasetDirectory, samplePredictionPath } from '../src/config.js';
import { assertDatasetAvailable } from '../src/dataset.js';

const predictionPath = samplePredictionPath;
const referencePath = resolve(datasetDirectory, 'sample_output.csv');
const stepFields = [
  'step_no',
  'phase',
  'system_id',
  'resource_id',
  'operation',
  'state',
  'evidence_id'
];
const coreFields = ['phase', 'system_id', 'resource_id', 'operation', 'state'];

function loadCsv(text, label) {
  const rows = parse(text, { bom: true, columns: true, skip_empty_lines: true });
  const ids = new Set();
  for (const row of rows) {
    if (!row.case_id || ids.has(row.case_id)) {
      throw new Error(`${label} has a missing or duplicate case_id`);
    }
    ids.add(row.case_id);
    try {
      row.steps = JSON.parse(row.steps_json);
    } catch (error) {
      throw new Error(`${label} has invalid steps_json for ${row.case_id}`, { cause: error });
    }
    if (!Array.isArray(row.steps)) throw new Error(`${label} steps_json must be an array`);
  }
  return rows;
}

function tupleKey(step, fields = coreFields) {
  return JSON.stringify(fields.map((field) => step[field] ?? null));
}

function countBy(items, keyFor) {
  const counts = new Map();
  for (const item of items) counts.set(keyFor(item), (counts.get(keyFor(item)) ?? 0) + 1);
  return counts;
}

function differenceCounts(left, right) {
  const result = new Map();
  for (const [key, count] of left) {
    const difference = count - (right.get(key) ?? 0);
    if (difference > 0) result.set(key, difference);
  }
  return result;
}

function expandCounts(counts) {
  return [...counts].flatMap(([key, count]) => Array.from({ length: count }, () => key));
}

function rowExact(prediction, reference) {
  if (prediction.deletion_status !== reference.deletion_status ||
      prediction.steps.length !== reference.steps.length) return false;
  return prediction.steps.every((step, index) => (
    stepFields.every((field) => step[field] === reference.steps[index][field])
  ));
}

function formatStep(step) {
  return JSON.stringify({
    phase: step.phase,
    system_id: step.system_id,
    resource_id: step.resource_id,
    operation: step.operation,
    state: step.state,
    evidence_id: step.evidence_id
  });
}

function analyzeCase(prediction, reference) {
  const predictedKeys = prediction.steps.map((step) => tupleKey(step));
  const referenceKeys = reference.steps.map((step) => tupleKey(step));
  const predictedCounts = countBy(predictedKeys, (key) => key);
  const referenceCounts = countBy(referenceKeys, (key) => key);
  const missingKeys = expandCounts(differenceCounts(referenceCounts, predictedCounts));
  const extraKeys = expandCounts(differenceCounts(predictedCounts, referenceCounts));
  const predictedByResource = countBy(prediction.steps, (step) => tupleKey(step, ['phase', 'system_id', 'resource_id']));
  const referenceByResource = countBy(reference.steps, (step) => tupleKey(step, ['phase', 'system_id', 'resource_id']));
  const operationStateDrift = [...differenceCounts(referenceByResource, predictedByResource)]
    .reduce((sum, [, count]) => sum + count, 0);
  const evidenceDrift = [];
  for (const expected of reference.steps) {
    const matching = prediction.steps.find((candidate) => tupleKey(candidate) === tupleKey(expected));
    if (matching && matching.evidence_id !== expected.evidence_id) evidenceDrift.push(expected);
  }
  const sequenceMismatch = JSON.stringify(predictedKeys) !== JSON.stringify(referenceKeys);
  const causes = [];
  if (prediction.deletion_status !== reference.deletion_status) causes.push('status mismatch');
  if (missingKeys.length) causes.push('missing steps');
  if (extraKeys.length) causes.push('extra steps');
  if (operationStateDrift > 0) causes.push('operation/state mismatch');
  if (evidenceDrift.length) causes.push('evidence_id mismatch');
  if (sequenceMismatch && !missingKeys.length && !extraKeys.length) causes.push('sequence/order mismatch');

  const missingSteps = missingKeys.map((key) => reference.steps.find((step) => tupleKey(step) === key));
  const extraSteps = extraKeys.map((key) => prediction.steps.find((step) => tupleKey(step) === key));
  const score = missingKeys.length + extraKeys.length + operationStateDrift +
    evidenceDrift.length + (prediction.deletion_status !== reference.deletion_status ? 1 : 0) +
    (sequenceMismatch ? 1 : 0);
  return {
    prediction,
    reference,
    causes,
    missingSteps,
    extraSteps,
    evidenceDrift,
    operationStateDrift,
    sequenceMismatch,
    score
  };
}

function rate(correct, total) {
  return total === 0 ? 'n/a' : `${(100 * correct / total).toFixed(1)}% (${correct}/${total})`;
}

function scoreDataset(predictions, references) {
  const predictionsById = new Map(predictions.map((row) => [row.case_id, row]));
  const referencesById = new Map(references.map((row) => [row.case_id, row]));
  const caseIds = [...referencesById.keys()].sort();
  const analyses = caseIds.map((caseId) => {
    const prediction = predictionsById.get(caseId);
    const reference = referencesById.get(caseId);
    if (!prediction) {
      return analyzeCase(
        { case_id: caseId, deletion_status: '(missing)', steps: [] },
        reference
      );
    }
    return analyzeCase(prediction, reference);
  });

  const statusCorrect = analyses.filter(({ prediction, reference }) => (
    prediction.deletion_status === reference.deletion_status
  )).length;
  const exactRows = analyses.filter(({ prediction, reference }) => rowExact(prediction, reference)).length;
  const predictedSteps = predictions.flatMap((row) => row.steps.map((step) => tupleKey(step)));
  const referenceSteps = references.flatMap((row) => row.steps.map((step) => tupleKey(step)));
  const predictedCounts = countBy(predictedSteps, (key) => key);
  const referenceCounts = countBy(referenceSteps, (key) => key);
  const truePositive = [...predictedCounts].reduce((total, [key, count]) => (
    total + Math.min(count, referenceCounts.get(key) ?? 0)
  ), 0);
  const precision = predictedSteps.length === 0 ? 1 : truePositive / predictedSteps.length;
  const recall = referenceSteps.length === 0 ? 1 : truePositive / referenceSteps.length;
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);

  const fieldCorrect = new Map(stepFields.map((field) => [field, 0]));
  const fieldTotal = new Map(stepFields.map((field) => [field, 0]));
  let sequenceCorrect = 0;
  for (const { prediction, reference } of analyses) {
    if (JSON.stringify(prediction.steps.map((step) => tupleKey(step))) ===
        JSON.stringify(reference.steps.map((step) => tupleKey(step)))) sequenceCorrect += 1;
    const length = Math.max(prediction.steps.length, reference.steps.length);
    for (let index = 0; index < length; index += 1) {
      for (const field of stepFields) {
        fieldTotal.set(field, fieldTotal.get(field) + 1);
        if (prediction.steps[index]?.[field] === reference.steps[index]?.[field]) {
          fieldCorrect.set(field, fieldCorrect.get(field) + 1);
        }
      }
    }
  }

  const failureGroups = new Map();
  for (const analysis of analyses) {
    for (const cause of analysis.causes) {
      const caseIdsForCause = failureGroups.get(cause) ?? [];
      if (caseIdsForCause.length < 3) caseIdsForCause.push(analysis.reference.case_id);
      failureGroups.set(cause, caseIdsForCause);
    }
  }

  const worst = [...analyses]
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score ||
      left.reference.case_id.localeCompare(right.reference.case_id))
    .slice(0, 5);

  const lines = [
    `Status accuracy: ${rate(statusCorrect, references.length)}`,
    `Exact row accuracy: ${rate(exactRows, references.length)}`,
    `Step precision/recall/F1: ${rate(truePositive, predictedSteps.length)} / ${rate(truePositive, referenceSteps.length)} / ${(100 * f1).toFixed(1)}%`,
    'Per-field accuracy (step fields):'
  ];
  for (const field of stepFields) {
    lines.push(`  ${field}: ${rate(fieldCorrect.get(field), fieldTotal.get(field))}`);
  }
  lines.push(`Sequence accuracy: ${rate(sequenceCorrect, references.length)}`);
  lines.push('Failure root causes (up to 3 cases each):');
  lines.push('| Root cause | Case IDs |');
  lines.push('|---|---|');
  for (const [cause, ids] of failureGroups) {
    lines.push(`| ${cause} | ${ids.join(', ')} |`);
  }
  if (failureGroups.size === 0) lines.push('| none | — |');
  lines.push('Worst-case missing/extra steps:');
  for (const analysis of worst) {
    lines.push(`  ${analysis.reference.case_id} (score ${analysis.score})`);
    const details = [
      ...analysis.missingSteps.map((step) => `    missing ${formatStep(step)}`),
      ...analysis.extraSteps.map((step) => `    extra ${formatStep(step)}`)
    ];
    if (analysis.prediction.deletion_status !== analysis.reference.deletion_status) {
      details.unshift(`    status predicted=${analysis.prediction.deletion_status} expected=${analysis.reference.deletion_status}`);
    }
    if (details.length === 0) details.push('    no missing/extra steps');
    lines.push(...details.slice(0, 7));
  }
  return lines.slice(0, 60);
}

async function main() {
  assertDatasetAvailable();
  const [predictionText, referenceText] = await Promise.all([
    readFile(predictionPath, 'utf8'),
    readFile(referencePath, 'utf8')
  ]);
  const predictions = loadCsv(predictionText, 'Predictions');
  const references = loadCsv(referenceText, 'Reference output');
  const missingReferences = references.filter(({ case_id }) => (
    !predictions.some((prediction) => prediction.case_id === case_id)
  ));
  const unexpectedPredictions = predictions.filter(({ case_id }) => (
    !references.some((reference) => reference.case_id === case_id)
  ));
  if (missingReferences.length || unexpectedPredictions.length) {
    throw new Error(`Case set mismatch: missing=${missingReferences.length}, unexpected=${unexpectedPredictions.length}`);
  }
  console.log(scoreDataset(predictions, references).join('\n'));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
