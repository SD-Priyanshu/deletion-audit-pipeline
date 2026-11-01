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

console.log('=== CHECKING STEP ORDERING IN DETAIL ===');

outputs.forEach(so => {
  const steps = JSON.parse(so.steps_json);
  if (steps.length > 3) {
    console.log(`\nCase [${so.case_id}] Status: ${so.deletion_status}`);
    const byPhase = {};
    steps.forEach(s => {
      if (!byPhase[s.phase]) byPhase[s.phase] = [];
      byPhase[s.phase].push(s);
    });
    for (const [phase, phaseSteps] of Object.entries(byPhase)) {
      console.log(`  Phase ${phase} (${phaseSteps.length} steps):`);
      phaseSteps.forEach(s => console.log(`    sys=${s.system_id} op=${s.operation} res=${s.resource_id}`));
    }
  }
});
