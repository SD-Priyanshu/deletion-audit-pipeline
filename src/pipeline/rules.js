const matrixOverrides = new Map([
  ['DATA_FLOW', 'DATA_FLOW']
]);

export function loadDeletionRules(database) {
  const rows = database.prepare(
    `SELECT data_category, required_action
     FROM deletion_rules
     WHERE data_category IS NOT NULL AND required_action IS NOT NULL
     ORDER BY rule_id`
  ).all();
  const rules = new Map();
  for (const row of rows) {
    if (!rules.has(row.data_category)) rules.set(row.data_category, row.required_action);
  }
  return rules;
}

export function requiredActionFor(dataCategory, rules) {
  const action = matrixOverrides.get(dataCategory) ?? rules.get(dataCategory);
  if (!action) throw new Error(`No deletion rule found for category ${dataCategory ?? '(null)'}`);
  return action;
}

