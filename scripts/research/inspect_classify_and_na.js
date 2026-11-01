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
const { rows: evidenceFiles } = parseCSV(path.join(datasetDir, 'evidence_files.csv'));
const { rows: users } = parseCSV(path.join(datasetDir, 'user_identities.csv'));
const { rows: auditLogs } = parseCSV(path.join(datasetDir, 'user_audit_log.csv'));
const { rows: rules } = parseCSV(path.join(datasetDir, 'deletion_rules.csv'));

console.log('===========================================================');
console.log('1. INVESTIGATING ALL EVENT_TYPES IN system_activity.csv');
console.log('===========================================================');
const eventTypes = [...new Set(activities.map(a => a.event_type))].sort();
for (const et of eventTypes) {
  const matching = activities.filter(a => a.event_type === et);
  console.log(`\nEvent Type: ${et} (Count: ${matching.length})`);
  console.log(`  Sample 1: res=${matching[0].resource_id} src=${matching[0].source_system}->tgt=${matching[0].target_system} res_res=${matching[0].reported_result}`);
  console.log(`    details="${matching[0].details}"`);
  if (matching.length > 1) {
    console.log(`  Sample 2: res=${matching[1].resource_id} src=${matching[1].source_system}->tgt=${matching[1].target_system} res_res=${matching[1].reported_result}`);
    console.log(`    details="${matching[1].details}"`);
  }
}

console.log('\n===========================================================');
console.log('2. INVESTIGATING CLASSIFY_REQUEST ACROSS ALL 518 REQUESTS');
console.log('===========================================================');
// Check those 10 accounts from CLASSIFY_REQUEST
const classifyRows = activities.filter(a => a.event_type === 'CLASSIFY_REQUEST');
console.log('10 CLASSIFY_REQUEST accounts:', classifyRows.map(c => c.resource_id).join(', '));

// Find if any of these 10 accounts belong to users in user_identities or evidence
const dbDir = path.join(datasetDir, 'evidence/databases');
const invFiles = fs.readdirSync(dbDir).filter(f => f.includes('customer_data_inventory'));
// check inventory files for these 10 accounts
const accToUser = {};
for (const f of invFiles) {
  const content = fs.readFileSync(path.join(dbDir, f), 'utf8');
  for (const cr of classifyRows) {
    const acc = cr.resource_id;
    const match = content.match(new RegExp(`VALUES\\('${acc}','([^']+)'`));
    if (match) {
      accToUser[acc] = match[1];
    }
  }
}
console.log('Classified accounts matched to users/references:', accToUser);

// Check if those users or emails appear in deletion_requests.csv!
for (const [acc, uref] of Object.entries(accToUser)) {
  const userObj = users.find(u => u.user_id === uref);
  const email = userObj ? userObj.email : '(no email)';
  const reqMatch = evalRequests.find(r => r.email.toLowerCase() === email.toLowerCase());
  console.log(`  Account ${acc} -> ${uref} -> ${email} -> In eval requests: ${reqMatch ? reqMatch.case_id : 'NO'}`);
  if (reqMatch) {
    console.log(`    Request text: "${reqMatch.request_text}"`);
  }
}

console.log('\n===========================================================');
console.log('3. INVESTIGATING NOT_APPLICABLE CASES ACROSS ALL 518 REQUESTS');
console.log('===========================================================');
// Categorize all 518 request texts
const textCategories = {
  deletion: [],
  access_only: [],
  export_only: [],
  rectification_only: [],
  opt_out_only: [],
  status_inquiry_only: [],
  other: []
};

// Let's print requests that look clearly non-deletion
const nonDeletionRequests = [];
for (const req of evalRequests) {
  const t = req.request_text.toLowerCase();
  
  // Explicit non-deletion patterns
  const isAccess = /access my data|copy of my personal data|export my data|download my data|provide a copy|send me my data|accéder à mes données|copie de mes données|acceder a mis datos|copia de mis datos/.test(t) && !/delete|close|remove|erase|supprimer|eliminar|borrar|effacer/.test(t);
  const isOptOut = /opt-out|marketing emails|unsubscribe|stop sending|désabonner|darme de baja|opt out/.test(t) && !/delete|close my account|remove my account|supprimer mon compte|eliminar mi cuenta/.test(t);
  const isRectify = /update my email|change my phone|correct my|rectify|mettre à jour|corregir/.test(t) && !/delete|close|remove|erase/.test(t);
  
  if (isAccess || isOptOut || isRectify) {
    nonDeletionRequests.push({ case_id: req.case_id, email: req.email, text: req.request_text, type: isAccess ? 'ACCESS/EXPORT' : (isOptOut ? 'MARKETING_OPT_OUT' : 'RECTIFY') });
  }
}
console.log(`Identified ${nonDeletionRequests.length} candidate NOT_APPLICABLE requests:`);
nonDeletionRequests.forEach(r => console.log(`  [${r.case_id}] (${r.type}) ${r.email}: "${r.text}"`));
