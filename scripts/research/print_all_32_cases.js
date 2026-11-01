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

const samples = parseCSV(path.join(datasetDir, 'sample_deletion_requests.csv'));
const outputs = parseCSV(path.join(datasetDir, 'sample_output.csv'));

console.log('=== FULL ANALYSIS OF ALL 32 SAMPLE CASES ===');
let completeCount = 0;
let incompleteCount = 0;

samples.forEach((req, idx) => {
  const out = outputs.find(o => o.case_id === req.case_id);
  const steps = out ? JSON.parse(out.steps_json) : [];
  if (out.deletion_status === 'COMPLETE') completeCount++;
  else if (out.deletion_status === 'INCOMPLETE') incompleteCount++;
  
  console.log(`\nCase ${req.case_id} (${out.deletion_status}) [Reported: ${req.reported_status}] audit_at: ${req.audit_at}`);
  console.log(`  Email: ${req.email}`);
  console.log(`  Req Text: "${req.request_text}"`);
  console.log(`  Steps (${steps.length}):`);
  steps.forEach(s => {
    console.log(`    #${s.step_no} [${s.phase}] sys=${s.system_id} res=${s.resource_id} op=${s.operation} state=${s.state} evid=${s.evidence_id || '""'}`);
  });
});

console.log(`\nSummary: Total ${samples.length} cases: ${completeCount} COMPLETE, ${incompleteCount} INCOMPLETE, 0 NOT_APPLICABLE`);
