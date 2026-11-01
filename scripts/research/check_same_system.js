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

outputs.forEach(row => {
  const steps = JSON.parse(row.steps_json);
  const counts = {};
  steps.forEach(s => {
    const key = `${s.phase}:${s.system_id}`;
    counts[key] = (counts[key] || 0) + 1;
  });
  for (const [k, cnt] of Object.entries(counts)) {
    if (cnt > 1) {
      console.log(`Case ${row.case_id} has ${cnt} steps in ${k}:`);
      steps.filter(s => `${s.phase}:${s.system_id}` === k).forEach(s => console.log('  ', s.step_no, s.resource_id, s.operation));
    }
  }
});
