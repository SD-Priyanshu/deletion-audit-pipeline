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

console.log('=== CHECKING VERIFICATION FOOTPRINT IN INCOMPLETE SAMPLES ===');

let totalIncomplete = 0;
let coversRemediated = 0;
let coversBaselineAccount = 0;
let coversSecurityAudit = 0;

outputs.filter(o => o.deletion_status === 'INCOMPLETE').forEach(o => {
  totalIncomplete++;
  const steps = JSON.parse(o.steps_json);
  const findings = steps.filter(s => s.phase === 'FINDING');
  const remediation = steps.filter(s => s.phase === 'REMEDIATION');
  const verification = steps.filter(s => s.phase === 'VERIFICATION');

  const findingRes = findings.map(s => s.resource_id);
  const remRes = remediation.map(s => s.resource_id);
  const verifRes = verification.map(s => s.resource_id);
  const verifSys = verification.map(s => s.system_id);

  // Does verification cover all remediated resources?
  const allRemInVerif = remRes.every(r => verifRes.includes(r));
  if (allRemInVerif) coversRemediated++;

  // Does verification include account_service?
  const hasAccount = verifSys.includes('account_service');
  if (hasAccount) coversBaselineAccount++;

  // Does verification include security_service?
  const hasSecurity = verifSys.includes('security_service');
  if (hasSecurity) coversSecurityAudit++;

  // Additional resources in verification not in remediation:
  const extraRes = verification.filter(s => !remRes.includes(s.resource_id)).map(s => `${s.system_id}:${s.resource_id}(${s.operation})`);

  console.log(`\nCase ${o.case_id}:`);
  console.log(`  Findings (${findings.length}): ${findingRes.join(', ')}`);
  console.log(`  Remediation (${remediation.length}): ${remRes.join(', ')}`);
  console.log(`  Verification (${verification.length}): ${verifRes.join(', ')}`);
  console.log(`  Extra in verification (baseline): ${extraRes.join(', ') || 'none'}`);
});

console.log(`\nTotals across ${totalIncomplete} INCOMPLETE cases:`);
console.log(`  Covers 100% of remediated resources: ${coversRemediated} / ${totalIncomplete}`);
console.log(`  Includes account_service baseline: ${coversBaselineAccount} / ${totalIncomplete}`);
console.log(`  Includes security_service baseline: ${coversSecurityAudit} / ${totalIncomplete}`);
