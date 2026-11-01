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

const opRank = {
  VERIFY_RECORD_ABSENT: 1,
  VERIFY_RECORD_PRESENT: 2,
  VERIFY_RECORD_REDACTED: 3,
  VERIFY_RECORD_ANONYMIZED: 4,
  VERIFY_DATA_FLOW_DISABLED: 5,
  VERIFY_RESTORE_BLOCKED: 6
};

let opViolations = 0;
let totalChecks = 0;

outputs.forEach(row => {
  const steps = JSON.parse(row.steps_json);
  const verif = steps.filter(s => s.phase === 'VERIFICATION');
  for (let i = 0; i < verif.length - 1; i++) {
    totalChecks++;
    const r1 = opRank[verif[i].operation] || 99;
    const r2 = opRank[verif[i+1].operation] || 99;
    if (r1 > r2) {
      console.log('Operation order mismatch in', row.case_id, verif[i].operation, '->', verif[i+1].operation);
      opViolations++;
    }
  }
});

console.log('Total verification operation sequence checks:', totalChecks, 'Violations:', opViolations);
