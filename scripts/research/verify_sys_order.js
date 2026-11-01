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
const sysRank = {
  account_service: 1,
  export_service: 2,
  search_service: 3,
  security_service: 4,
  support_platform: 5,
  analytics_platform: 6,
  integration_service: 7,
  backup_service: 8,
  identity_service: 9
};

let violations = 0;
let totalVerifChecks = 0;

outputs.forEach(row => {
  const steps = JSON.parse(row.steps_json);
  const verif = steps.filter(s => s.phase === 'VERIFICATION');
  for (let i = 0; i < verif.length - 1; i++) {
    totalVerifChecks++;
    const r1 = sysRank[verif[i].system_id] || 99;
    const r2 = sysRank[verif[i+1].system_id] || 99;
    if (r1 > r2) {
      console.log('Order mismatch in', row.case_id, verif[i].system_id, '->', verif[i+1].system_id);
      violations++;
    }
  }
});
console.log('Total verification sequence checks:', totalVerifChecks, 'Violations:', violations);
