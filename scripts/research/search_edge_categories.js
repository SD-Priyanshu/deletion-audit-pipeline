const fs = require('fs');
const path = require('path');

const { datasetDir } = require('./paths.cjs');

function parseCSVLine(line) {
  const result = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else cur += c;
  }
  result.push(cur); return result;
}

function parseCSV(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim().length > 0);
  const headers = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map(l => {
    const vals = parseCSVLine(l);
    const obj = {}; headers.forEach((h, i) => obj[h] = vals[i] || '');
    return obj;
  });
  return rows;
}

const evidenceFiles = parseCSV(path.join(datasetDir, 'evidence_files.csv'));
const activities = parseCSV(path.join(datasetDir, 'system_activity.csv'));
const requests = parseCSV(path.join(datasetDir, 'deletion_requests.csv'));

const categories = [
  'MARKETING_PROFILE',
  'CACHE_ENTRY',
  'SECONDARY_IDENTIFIER',
  'PRODUCT_TELEMETRY',
  'EMAIL_DELIVERY_LOG',
  'LEGAL_HOLD_RECORD'
];

console.log('=== SEARCHING FOR 6 CATEGORIES IN system_activity.csv ===');
categories.forEach(cat => {
  const inAct = activities.filter(a => 
    a.event_type.includes(cat) || 
    a.details.includes(cat) || 
    a.resource_id.toLowerCase().includes(cat.toLowerCase().replace('_record', '').replace('_entry', '').replace('_profile', '').replace('_log', ''))
  );
  console.log(`\nCategory: ${cat}`);
  console.log(`  Matching activities: ${inAct.length}`);
  if (inAct.length > 0) {
    const systems = [...new Set(inAct.map(a => `${a.source_system}->${a.target_system}`))];
    const prefixes = [...new Set(inAct.map(a => a.resource_id.split('_')[0] + '_*'))];
    console.log(`  Systems: ${systems.join(', ')}`);
    console.log(`  Resource prefixes: ${prefixes.join(', ')}`);
    console.log(`  Sample: res=${inAct[0].resource_id} event=${inAct[0].event_type} details=${inAct[0].details}`);
  }
});

// Also check specific prefixes:
// cache_*, email_delivery_*, legal_hold_*, telemetry_*, marketing_*
console.log('\n=== CHECKING SPECIFIC RESOURCE PREFIXES IN system_activity.csv ===');
const prefixesToCheck = ['cache_', 'email_delivery_', 'legal_hold_', 'telemetry_', 'marketing_', 'secondary_'];
prefixesToCheck.forEach(pref => {
  const m = activities.filter(a => a.resource_id.startsWith(pref));
  console.log(`Prefix: ${pref}* -> Count in system_activity: ${m.length}`);
  if (m.length > 0) {
    const sys = [...new Set(m.map(a => `${a.source_system}->${a.target_system}`))];
    console.log(`  Systems: ${sys.join(', ')}`);
    console.log(`  Sample: res=${m[0].resource_id} src=${m[0].source_system}->${m[0].target_system} evt=${m[0].event_type} details="${m[0].details}"`);
  }
});

console.log('\n=== SCANNING ALL 94 EVIDENCE FILES FOR THESE CATEGORIES & PREFIXES ===');
const foundInEvidence = {};
categories.forEach(c => foundInEvidence[c] = []);
prefixesToCheck.forEach(p => foundInEvidence[p] = []);

evidenceFiles.forEach(ef => {
  const fullPath = path.join(datasetDir, ef.file_path);
  if (fs.existsSync(fullPath)) {
    try {
      const txt = fs.readFileSync(fullPath, 'utf8');
      categories.forEach(cat => {
        if (txt.includes(cat)) {
          foundInEvidence[cat].push(ef.file_id + ' (' + ef.file_path + ')');
        }
      });
      prefixesToCheck.forEach(pref => {
        const regex = new RegExp(`\\b${pref}[0-9]+`, 'g');
        const matches = txt.match(regex);
        if (matches && matches.length > 0) {
          foundInEvidence[pref].push({ file: ef.file_id + ' (' + ef.file_path + ')', matches: [...new Set(matches)] });
        }
      });
    } catch (e) {}
  }
});

categories.forEach(cat => {
  console.log(`Category ${cat} found in evidence files: ${foundInEvidence[cat].length}`);
  if (foundInEvidence[cat].length > 0) {
    console.log('  Files:', foundInEvidence[cat].slice(0, 5).join('; '));
  }
});

prefixesToCheck.forEach(pref => {
  console.log(`Prefix ${pref}* found in evidence files: ${foundInEvidence[pref].length}`);
  if (foundInEvidence[pref].length > 0) {
    foundInEvidence[pref].slice(0, 3).forEach(x => {
      console.log(`  File: ${x.file} -> IDs: ${x.matches.slice(0, 5).join(', ')}`);
    });
  }
});

// Check if any of these match the 518 evaluation requests!
console.log('\n=== CHECKING IF ANY OF THESE PREFIXES MATCH 518 EVALUATION REQUESTS ===');
// E.g. in SQL inventory or snapshot bundles, do cache_*, legal_hold_*, email_delivery_* connect to any of the 518 users?
const allEvalEmails = new Set(requests.map(r => r.email.toLowerCase()));

// check legal_hold in SQL
for (const ef of evidenceFiles.filter(f => f.file_path.endsWith('.sql'))) {
  const p = path.join(datasetDir, ef.file_path);
  const txt = fs.readFileSync(p, 'utf8');
  if (txt.includes('legal_hold_')) {
    const lines = txt.split('\n').filter(l => l.includes('legal_hold_'));
    console.log(`Legal hold in ${ef.file_id}: ${lines.length} lines`);
    lines.forEach(l => console.log('  ', l.slice(0, 160)));
  }
}
