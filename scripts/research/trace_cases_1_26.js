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
const activities = parseCSV(path.join(datasetDir, 'system_activity.csv'));
const rules = parseCSV(path.join(datasetDir, 'deletion_rules.csv'));
const evidenceFiles = parseCSV(path.join(datasetDir, 'evidence_files.csv'));

console.log('Tracing cases 1 to 26...');
samples.slice(0, 26).forEach((req) => {
  const out = outputs.find(o => o.case_id === req.case_id);
  const steps = out ? JSON.parse(out.steps_json) : [];
  console.log(`\nCase ${req.case_id} (${out.deletion_status}) [Reported: ${req.reported_status}] audit_at: ${req.audit_at}`);
  console.log(`  Email: ${req.email}`);
  console.log(`  Req: "${req.request_text}"`);
  steps.forEach(s => {
    // find related rule
    let matchedRule = 'unknown';
    if (s.system_id === 'account_service' && s.operation.includes('RECORD')) matchedRule = 'rule_01 (USER_PROFILE: DELETE)';
    else if (s.system_id === 'search_service' && s.operation.includes('RECORD')) matchedRule = 'rule_03 (SEARCH_INDEX_ENTRY: DELETE)';
    else if (s.system_id === 'support_platform' && s.resource_id.startsWith('support_') && s.operation.includes('REDACT')) matchedRule = 'rule_05 (SUPPORT_MESSAGE: REDACT)';
    else if (s.system_id === 'support_platform' && s.resource_id.startsWith('support_') && s.operation.includes('DELETE')) matchedRule = 'rule_06 (SUPPORT_ATTACHMENT: DELETE)';
    else if (s.system_id === 'analytics_platform') matchedRule = 'rule_07 (ANALYTICS_PROFILE: ANONYMIZE)';
    else if (s.system_id === 'export_service') matchedRule = 'rule_09 (USER_EXPORT: DELETE)';
    else if (s.system_id === 'security_service') matchedRule = 'rule_12 (SECURITY_AUDIT_LOG: RETAIN)';
    else if (s.system_id === 'backup_service') matchedRule = 'rule_14 (BACKUP_ARCHIVE: RETAIN/BLOCK)';
    else if (s.system_id === 'identity_service' && s.resource_id.startsWith('tombstone_')) matchedRule = 'rule_15 (ACCOUNT_TOMBSTONE: REDACT)';
    else if (s.system_id === 'integration_service') matchedRule = 'Data Flow (Active Sync)';

    // find related system activity
    const relAct = activities.filter(a => a.resource_id === s.resource_id && new Date(a.event_time) <= new Date(req.audit_at));
    const actSummary = relAct.map(a => `${a.event_type}:${a.reported_result}`).join(', ') || 'none';

    console.log(`    #${s.step_no} [${s.phase}] sys=${s.system_id} res=${s.resource_id} op=${s.operation} state=${s.state} evid=${s.evidence_id || '""'} | Rule: ${matchedRule} | Acts: ${actSummary}`);
  });
});
