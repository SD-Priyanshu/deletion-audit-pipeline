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

const { rows: evalRequests } = parseCSV(path.join(datasetDir, 'deletion_requests.csv'));
const { rows: activities } = parseCSV(path.join(datasetDir, 'system_activity.csv'));
const { rows: sampleRequests } = parseCSV(path.join(datasetDir, 'sample_deletion_requests.csv'));
const { rows: sampleOutput } = parseCSV(path.join(datasetDir, 'sample_output.csv'));
const { rows: evidenceFiles } = parseCSV(path.join(datasetDir, 'evidence_files.csv'));
const { rows: rules } = parseCSV(path.join(datasetDir, 'deletion_rules.csv'));

console.log('================================================================');
console.log('FINDING ALL NON-DELETION (NOT_APPLICABLE) REQUESTS IN 518 CASES');
console.log('================================================================');

const nonDelete = [];
for (const r of evalRequests) {
  const txt = r.request_text.toLowerCase();
  // check if request clearly asks for deletion
  const isDeletion = /delete|deletion|supprimer|suppression|eliminar|eliminación|exclusão|excluir|close|closed|closing|remove my account|erase|erasure|geschlossen|löschen|borrar/.test(txt);
  if (!isDeletion) {
    nonDelete.push(r);
  }
}

console.log(`Requests without standard deletion keywords: ${nonDelete.length}`);
nonDelete.forEach(r => {
  console.log(`  [${r.case_id}] ${r.email}: "${r.request_text}"`);
});

console.log('\n================================================================');
console.log('INVESTIGATING STEP ORDERING AND RESOURCE_ID SORTING (QUESTION 5)');
console.log('================================================================');
// Let's examine step ordering in all 32 sample cases
let stringSortCount = 0;
let numericSortCount = 0;

sampleOutput.forEach(so => {
  const steps = JSON.parse(so.steps_json);
  if (steps.length > 1) {
    console.log(`\nCase [${so.case_id}] status=${so.deletion_status} (${steps.length} steps):`);
    steps.forEach(s => {
      console.log(`  Step ${s.step_no} [${s.phase}] sys=${s.system_id} res=${s.resource_id} op=${s.operation}`);
    });
  }
});

console.log('\n================================================================');
console.log('INVESTIGATING EVIDENCE SELECTION: CAPTURED_AT VS AUDIT_AT (QUESTION 3)');
console.log('================================================================');

// Map evidence_id to captured_at
const evidMap = {};
evidenceFiles.forEach(ef => {
  evidMap[ef.file_id] = { path: ef.file_path, captured_at: ef.captured_at, origin: ef.origin };
});

sampleOutput.forEach(so => {
  const req = sampleRequests.find(r => r.case_id === so.case_id);
  const steps = JSON.parse(so.steps_json);
  const citedEvids = [...new Set(steps.map(s => s.evidence_id).filter(e => e && e.length > 0))];
  
  if (citedEvids.length > 0) {
    console.log(`\nCase [${so.case_id}] audit_at=${req ? req.audit_at : 'UNKNOWN'}`);
    citedEvids.forEach(eid => {
      const ef = evidMap[eid];
      const diffMs = ef ? (new Date(req.audit_at) - new Date(ef.captured_at)) : null;
      console.log(`  Cited: ${eid} (${ef ? ef.path : 'missing'}), captured_at=${ef ? ef.captured_at : '?'}, before_audit=${diffMs >= 0 ? 'YES' : 'VIOLATION!'} (diff=${diffMs / 1000 / 3600} hrs)`);
    });
  }
});
