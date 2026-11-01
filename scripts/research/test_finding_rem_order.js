const fs = require('fs');
const path = require('path');

const { datasetDir } = require('./paths.cjs');

function parseCSV(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim().length > 0);
  const parseLine = (l) => {
    const res = []; let c = ''; let q = false;
    for (let i = 0; i < l.length; i++) {
      if (l[i] === '"') { if (q && l[i+1] === '"') { c += '"'; i++; } else q = !q; }
      else if (l[i] === ',' && !q) { res.push(c); c = ''; }
      else c += l[i];
    }
    res.push(c); return res;
  };
  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(l => {
    const vals = parseLine(l);
    const obj = {}; headers.forEach((h, i) => obj[h] = vals[i] || '');
    return obj;
  });
  return rows;
}

const outputs = parseCSV(path.join(datasetDir, 'sample_output.csv'));

const findingOpRank = {
  REPORT_REMAINING_RECORD: 1,
  REPORT_EXPOSED_PII: 2,
  REPORT_ACTIVE_DATA_FLOW: 3,
  REPORT_RESTORE_RISK: 4
};

let findingViolations = 0;
let totalFindingChecks = 0;

outputs.forEach(row => {
  const steps = JSON.parse(row.steps_json);
  const findings = steps.filter(s => s.phase === 'FINDING');
  for (let i = 0; i < findings.length - 1; i++) {
    totalFindingChecks++;
    const r1 = findingOpRank[findings[i].operation] || 99;
    const r2 = findingOpRank[findings[i+1].operation] || 99;
    if (r1 > r2) {
      console.log('Finding Op mismatch in', row.case_id, findings[i].operation, '->', findings[i+1].operation);
      findingViolations++;
    }
  }
});
console.log('Total Finding sequence checks:', totalFindingChecks, 'Violations:', findingViolations);

const remOpRank = {
  DISABLE_DATA_FLOW: 1,
  BLOCK_RESTORE: 2,
  DELETE_RECORD: 3,
  REDACT_RECORD: 4,
  ANONYMIZE_RECORD: 5
};

let remViolations = 0;
let totalRemChecks = 0;

outputs.forEach(row => {
  const steps = JSON.parse(row.steps_json);
  const rem = steps.filter(s => s.phase === 'REMEDIATION');
  for (let i = 0; i < rem.length - 1; i++) {
    totalRemChecks++;
    const r1 = remOpRank[rem[i].operation] || 99;
    const r2 = remOpRank[rem[i+1].operation] || 99;
    if (r1 > r2) {
      console.log('Remediation Op mismatch in', row.case_id, rem[i].operation, '->', rem[i+1].operation);
      remViolations++;
    }
  }
});
console.log('Total Remediation sequence checks:', totalRemChecks, 'Violations:', remViolations);
