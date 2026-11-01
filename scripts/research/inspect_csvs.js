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
  const rawLines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines = rawLines.filter(l => l.trim().length > 0);
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

const csvFiles = [
  'deletion_requests.csv',
  'user_identities.csv',
  'user_audit_log.csv',
  'system_activity.csv',
  'deletion_rules.csv',
  'evidence_files.csv',
  'sample_deletion_requests.csv',
  'sample_output.csv',
  'output.csv'
];

console.log('========================================================');
console.log('DATASET CSV INSPECTION SUMMARY');
console.log('Dataset path:', datasetDir);
console.log('========================================================\n');

for (const file of csvFiles) {
  const fullPath = path.join(datasetDir, file);
  if (!fs.existsSync(fullPath)) {
    console.log(`[MISSING] ${file}\n`);
    continue;
  }
  const { headers, rows } = parseCSV(fullPath);
  console.log(`--------------------------------------------------------`);
  console.log(`File: dataset/${file}`);
  console.log(`Row count: ${rows.length}`);
  console.log(`Headers (${headers.length}):`, headers.join(', '));
  console.log(`--------------------------------------------------------`);

  console.log('\n--- 5 Sample Rows ---');
  const sample = rows.slice(0, 5);
  sample.forEach((r, idx) => {
    console.log(`Row ${idx + 1}:`, JSON.stringify(r));
  });

  console.log('\n--- Categorical Columns & Distinct Values ---');
  for (const h of headers) {
    const distinct = new Set(rows.map(r => r[h]));
    // Check if categorical (e.g., <= 30 distinct values or known categorical fields)
    if (distinct.size <= 30 && distinct.size > 0 && distinct.size < rows.length) {
      console.log(`  Column '${h}' (${distinct.size} distinct values):`);
      const sortedVals = Array.from(distinct).sort();
      sortedVals.forEach(v => console.log(`    - "${v}"`));
    }
  }

  // Special checks for specific files
  if (file === 'evidence_files.csv') {
    const extCounts = {};
    rows.forEach(r => {
      const ext = path.extname(r.file_path).toLowerCase();
      extCounts[ext] = (extCounts[ext] || 0) + 1;
    });
    console.log('\n  Evidence File Extensions Breakdown:');
    Object.entries(extCounts).sort().forEach(([ext, cnt]) => {
      console.log(`    - ${ext}: ${cnt}`);
    });
  }

  console.log('\n');
}
