CREATE TABLE IF NOT EXISTS deletion_requests (
  case_id TEXT PRIMARY KEY,
  email TEXT,
  requested_at TEXT,
  reported_status TEXT,
  reported_at TEXT,
  audit_at TEXT,
  request_text TEXT
);

CREATE TABLE IF NOT EXISTS user_identities (
  user_id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  phone TEXT,
  email_hash TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS user_audit_log (
  audit_id TEXT PRIMARY KEY,
  user_id TEXT,
  event_time TEXT,
  field_name TEXT,
  old_value TEXT,
  new_value TEXT
);

CREATE TABLE IF NOT EXISTS system_activity (
  activity_id TEXT PRIMARY KEY,
  event_time TEXT,
  event_type TEXT,
  source_system TEXT,
  target_system TEXT,
  resource_id TEXT,
  reported_result TEXT,
  details TEXT
);

CREATE TABLE IF NOT EXISTS deletion_rules (
  rule_id TEXT PRIMARY KEY,
  data_category TEXT,
  condition TEXT,
  required_action TEXT
);

CREATE TABLE IF NOT EXISTS evidence_files (
  file_id TEXT PRIMARY KEY,
  file_path TEXT,
  origin TEXT,
  captured_at TEXT
);

CREATE TABLE IF NOT EXISTS evidence_facts (
  fact_id INTEGER PRIMARY KEY,
  case_id TEXT,
  user_id TEXT,
  resource_id TEXT,
  system_id TEXT,
  data_category TEXT,
  state TEXT,
  evidence_id TEXT,
  captured_at TEXT,
  fact_json TEXT,
  location TEXT,
  identifiers TEXT
);

CREATE TABLE IF NOT EXISTS evidence_coverage (
  coverage_id INTEGER PRIMARY KEY,
  evidence_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS case_identifiers (
  identifier_id INTEGER PRIMARY KEY,
  case_id TEXT,
  user_id TEXT,
  identifier_type TEXT,
  identifier_value TEXT,
  source TEXT,
  source_id TEXT,
  observed_at TEXT
);

CREATE TABLE IF NOT EXISTS resource_states (
  state_id INTEGER PRIMARY KEY,
  case_id TEXT,
  resource_id TEXT,
  system_id TEXT,
  data_category TEXT,
  state TEXT,
  evidence_id TEXT,
  captured_at TEXT,
  fact_json TEXT
);

CREATE TABLE IF NOT EXISTS case_results (
  case_id TEXT PRIMARY KEY,
  deletion_status TEXT,
  steps_json TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS llm_cache (
  cache_key TEXT PRIMARY KEY,
  request_json TEXT,
  response_json TEXT,
  model TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS llm_usage (
  usage_id INTEGER PRIMARY KEY,
  case_id TEXT,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  created_at TEXT
);
