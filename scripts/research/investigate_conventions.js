const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { datasetDir } = require('./paths.cjs');

function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
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
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = vals[idx] !== undefined ? vals[idx] : '';
    });
    rows.push(obj);
  }
  return { headers, rows };
}

// -------------------------------------------------------------
// 1. Verify email_hash algorithm
// -------------------------------------------------------------
console.log('====================================================');
console.log('QUESTION 4: Verify email_hash algorithm');
console.log('====================================================');
const { rows: users } = parseCSV(path.join(datasetDir, 'user_identities.csv'));
let sha256Matches = 0;
let sha256LowerMatches = 0;
let sha256TrimLowerMatches = 0;

for (const u of users) {
  const email = u.email;
  const hash = u.email_hash;
  const h1 = crypto.createHash('sha256').update(email).digest('hex');
  const h2 = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
  const h3 = crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

  if (h1 === hash) sha256Matches++;
  if (h2 === hash) sha256LowerMatches++;
  if (h3 === hash) sha256TrimLowerMatches++;
}

console.log(`Total users tested: ${users.length}`);
console.log(`SHA-256(raw email): ${sha256Matches} / ${users.length}`);
console.log(`SHA-256(lowercase email): ${sha256LowerMatches} / ${users.length}`);
console.log(`SHA-256(trim lowercase email): ${sha256TrimLowerMatches} / ${users.length}`);

// Sample hash check
const sampleUser = users[0];
console.log(`Sample user: ${sampleUser.email} -> ${sampleUser.email_hash}`);
console.log(`Computed SHA256(lowercase): ${crypto.createHash('sha256').update(sampleUser.email.toLowerCase()).digest('hex')}`);


// -------------------------------------------------------------
// 2. System Activity: CLASSIFY_REQUEST & LINK_RESOURCE_IDENTITY
// -------------------------------------------------------------
console.log('\n====================================================');
console.log('QUESTION 1: CLASSIFY_REQUEST & LINK_RESOURCE_IDENTITY in system_activity.csv');
console.log('====================================================');
const { rows: activities } = parseCSV(path.join(datasetDir, 'system_activity.csv'));
const classifyRows = activities.filter(a => a.event_type === 'CLASSIFY_REQUEST');
const linkRows = activities.filter(a => a.event_type === 'LINK_RESOURCE_IDENTITY');

console.log(`Total activities: ${activities.length}`);
console.log(`CLASSIFY_REQUEST count: ${classifyRows.length}`);
console.log(`LINK_RESOURCE_IDENTITY count: ${linkRows.length}`);

console.log('\nSample CLASSIFY_REQUEST rows (5):');
classifyRows.slice(0, 5).forEach((r, idx) => {
  console.log(`  [${idx + 1}] time=${r.event_time} src=${r.source_system} tgt=${r.target_system} res=${r.resource_id} res_res=${r.reported_result}`);
  console.log(`      details=${r.details}`);
});

console.log('\nSample LINK_RESOURCE_IDENTITY rows (5):');
linkRows.slice(0, 5).forEach((r, idx) => {
  console.log(`  [${idx + 1}] time=${r.event_time} src=${r.source_system} tgt=${r.target_system} res=${r.resource_id} res_res=${r.reported_result}`);
  console.log(`      details=${r.details}`);
});

// Check distinct classifications in CLASSIFY_REQUEST
const classifyDetails = classifyRows.map(r => r.details);
console.log('\nDistinct pattern of details in CLASSIFY_REQUEST:');
const uniqueClassifyDetails = [...new Set(classifyDetails)];
console.log(`Unique details values count: ${uniqueClassifyDetails.length}`);
uniqueClassifyDetails.slice(0, 10).forEach(d => console.log('  -', d));


// -------------------------------------------------------------
// 3. Question 2: NOT_APPLICABLE cases across deletion_requests.csv
// -------------------------------------------------------------
console.log('\n====================================================');
console.log('QUESTION 2: NOT_APPLICABLE cases across all 518 deletion_requests.csv');
console.log('====================================================');
const { rows: evalRequests } = parseCSV(path.join(datasetDir, 'deletion_requests.csv'));

// Check how many evalRequests match CLASSIFY_REQUEST activity by email or case_id
console.log(`Eval requests count: ${evalRequests.length}`);
let matchedClassifyByEmail = 0;
let matchedClassifyByCase = 0;

for (const req of evalRequests) {
  const matchE = classifyRows.filter(c => c.details.includes(req.email) || c.resource_id === req.email);
  if (matchE.length > 0) matchedClassifyByEmail++;
  const matchC = classifyRows.filter(c => c.details.includes(req.case_id) || c.resource_id === req.case_id);
  if (matchC.length > 0) matchedClassifyByCase++;
}
console.log(`Requests matched to CLASSIFY_REQUEST by email: ${matchedClassifyByEmail}`);
console.log(`Requests matched to CLASSIFY_REQUEST by case_id: ${matchedClassifyByCase}`);

// Let's inspect request_text patterns for potential NOT_APPLICABLE
console.log('\nInspecting request_text patterns:');
const nonDeletionKeywords = ['access', 'export', 'download', 'update', 'modify', 'rectify', 'opt-out', 'marketing', 'unsubscribe', 'status', 'copy', 'portable'];
const potentialNotApplicable = [];
for (const req of evalRequests) {
  const txt = req.request_text.toLowerCase();
  // check if request does NOT ask to delete/close/remove/erase/forget
  const hasDelete = /delete|close|remove|erase|forget|supprimer|eliminar|löschen|borrar|effacer/.test(txt);
  if (!hasDelete) {
    potentialNotApplicable.push(req);
  }
}
console.log(`Requests without common delete keywords: ${potentialNotApplicable.length}`);
console.log('Sample requests without deletion keywords:');
potentialNotApplicable.slice(0, 8).forEach(r => {
  console.log(`  [${r.case_id}] email=${r.email} text="${r.request_text}"`);
});
