const fs = require('fs');
const path = require('path');

const { datasetDir } = require('./paths.cjs');

function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

function parseCSV(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim().length > 0);
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = vals[idx] !== undefined ? vals[idx] : ''; });
    rows.push(obj);
  }
  return { headers, rows };
}

const { rows: activities } = parseCSV(path.join(datasetDir, 'system_activity.csv'));
const { rows: evalRequests } = parseCSV(path.join(datasetDir, 'deletion_requests.csv'));
const { rows: sampleRequests } = parseCSV(path.join(datasetDir, 'sample_deletion_requests.csv'));
const { rows: sampleOutput } = parseCSV(path.join(datasetDir, 'sample_output.csv'));
const { rows: users } = parseCSV(path.join(datasetDir, 'user_identities.csv'));

const classifyRows = activities.filter(a => a.event_type === 'CLASSIFY_REQUEST');

console.log('--- Checking CLASSIFY_REQUEST accounts against evidence / requests ---');
for (const cr of classifyRows) {
  const accId = cr.resource_id;
  // search in activities
  const otherActs = activities.filter(a => a.resource_id === accId && a.activity_id !== cr.activity_id);
  console.log(`\nAccount: ${accId}`);
  console.log(`  CLASSIFY details: ${cr.details}`);
  console.log(`  Other activities count: ${otherActs.length}`);
  otherActs.slice(0, 3).forEach(oa => console.log(`    ${oa.event_type} (${oa.source_system}->${oa.target_system}) res_res=${oa.reported_result} details=${oa.details}`));
}

// Now let's trace each of the 32 sample cases in sample_deletion_requests.csv vs sample_output.csv!
console.log('\n=============================================================');
console.log('TRACING ALL 32 SAMPLE CASES');
console.log('=============================================================');

sampleRequests.forEach((req, idx) => {
  const out = sampleOutput.find(o => o.case_id === req.case_id);
  const steps = out ? JSON.parse(out.steps_json) : [];
  console.log(`\nCase [${req.case_id}] (Sample #${idx + 1}): email=${req.email} audit_at=${req.audit_at} reported_status=${req.reported_status}`);
  console.log(`  Actual status in sample_output: ${out ? out.deletion_status : 'MISSING'}, Steps count: ${steps.length}`);
  console.log(`  Request text: "${req.request_text}"`);
  steps.forEach(st => {
    console.log(`    Step ${st.step_no}: phase=${st.phase} sys=${st.system_id} res=${st.resource_id} op=${st.operation} state=${st.state} evid=${st.evidence_id || '(none)'}`);
  });
});
