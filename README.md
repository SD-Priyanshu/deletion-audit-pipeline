# Ghost Data Still Exists

## The problem

A deletion workflow can report success while personal data remains in replicas, indexes, logs, exports, analytics, support systems, archives, or backups. This project audits deletion requests and supporting evidence at each request's `audit_at` time, distinguishing deletion authorization from unrelated privacy requests. It applies the supplied retention, redaction, anonymization, and deletion rules and plans remediation when the evidence shows a violation.

## What it outputs

The audit writes `output.csv` with one row per request and a JSON array of evidence-backed findings, ordered remediation, and verification steps. This invented example shows an incomplete deletion with a surviving profile and a connector that could copy it again; the CSV encodes the `steps_json` array in one field:

```json
{
  "case_id": "demo_case",
  "deletion_status": "INCOMPLETE",
  "steps_json": [
    {"step_no":1,"phase":"FINDING","system_id":"account_service","resource_id":"profile_demo_01","operation":"REPORT_REMAINING_RECORD","state":"PRESENT","evidence_id":"demo_evidence_profile"},
    {"step_no":2,"phase":"FINDING","system_id":"integration_service","resource_id":"flow_demo_01","operation":"REPORT_ACTIVE_DATA_FLOW","state":"ACTIVE","evidence_id":"demo_evidence_flow"},
    {"step_no":3,"phase":"REMEDIATION","system_id":"integration_service","resource_id":"flow_demo_01","operation":"DISABLE_DATA_FLOW","state":"DISABLED","evidence_id":""},
    {"step_no":4,"phase":"REMEDIATION","system_id":"account_service","resource_id":"profile_demo_01","operation":"DELETE_RECORD","state":"ABSENT","evidence_id":""},
    {"step_no":5,"phase":"VERIFICATION","system_id":"account_service","resource_id":"profile_demo_01","operation":"VERIFY_RECORD_ABSENT","state":"ABSENT","evidence_id":""},
    {"step_no":6,"phase":"VERIFICATION","system_id":"integration_service","resource_id":"flow_demo_01","operation":"VERIFY_DATA_FLOW_DISABLED","state":"DISABLED","evidence_id":""}
  ]
}
```

## Results

Measured on the 32 public sample cases:

| Metric | Result |
|---|---:|
| Deletion-status accuracy | 100.0% (32/32) |
| Exact row accuracy | 31.3% (10/32) |
| Precision | 100.0% (161/161) |
| Recall | 83.4% (161/193) |
| F1 | 91.0% |

All 32 sample cases are deletion requests; non-deletion (`NOT_APPLICABLE`) handling has no ground-truth score.

These are the 32 public sample cases from HackerRank's Orchestrate challenge on which the rules were tuned; nothing is claimed for unseen data.

Clean-copy validation results:

| Check | Result |
|---|---:|
| Full-run statuses (518 requests) | 163 `COMPLETE`; 345 `INCOMPLETE`; 10 `NOT_APPLICABLE` |
| `npm run audit` time | 19.209 seconds |
| `llm_usage` rows | 0 |
| `npm test` with dataset | 83 passed; 0 skipped (7 files) |
| `npm test` without dataset | 13 passed; 70 skipped (5 passed, 2 skipped files) |
| `npm run eval` without dataset | Exit code 1; friendly missing-dataset message |

### Sample output

```text
Status accuracy: 100.0% (32/32)
Exact row accuracy: 31.3% (10/32)
Step precision/recall/F1: 100.0% (161/161) / 83.4% (161/193) / 91.0%
```

## How it works

1. Intent: decide whether the request authorizes deletion.
2. Identity: resolve current and historical identifiers by exact match.
3. Evidence facts: extract records, identifiers, states, and capture times.
4. Footprint: link relevant resources only through grounded identifiers.
5. State at `audit_at`: ignore later evidence and workflow claims.
6. Rules: apply the supplied delete, redact, anonymize, and retain policies.
7. Ordered plan: report findings, stop recreation risks, remediate, and verify.

## Design choices

- Deterministic code is used instead of an LLM for reproducible, inspectable decisions.
- The pipeline made zero model calls in the measured run.
- Identity and resource linking use exact normalized identifiers only; there is no fuzzy or timestamp-based identity inference.

## Limitations

- All 32 sample cases are deletion requests; non-deletion (`NOT_APPLICABLE`) handling has no ground-truth score.
- 79 of 111 sample case/resource pairs link through exact identifiers; unlinked `account_*` and `audit_record_*` resources may be missed.
- A timestamp-linking experiment was rejected: 3/25 candidate links were unique within 5 minutes, 7/25 within 60 minutes, and 0/7 audit-record links were unique.
- Support-message versus attachment classification remains heuristic when the evidence does not state the record type.
- The sample results do not establish accuracy on unseen data.

## How to run

The dataset belongs to HackerRank's Orchestrate challenge repository and is not included here. Place the participant-facing dataset contents in `./dataset`; optionally set `DATASET_DIR` to another path. Node.js 24 (tested on v24.18.0) and npm are required.

```sh
npm install
npm run ingest
npm run extract-evidence
npm run audit:sample
npm run eval
npm test
npm run audit
```

The database is written to `./data/orchestrate.sqlite`, sample predictions to `./data/sample_predictions.csv`, and the full result to `./output.csv`. `.env.example` documents the empty `API_KEY` setting; the deterministic pipeline does not require a key.

## Project structure

- `src/`: ingestion, evidence extraction, audit pipeline, and shared configuration.
- `test/`: unit, integration, and dataset-backed tests.
- `evaluation/`: sample scoring, synthetic cases, and evaluation/usage reports.
- `docs/`: policy conventions and decision matrices.
- `scripts/research/`: exploratory analysis scripts used while studying the sample data (not part of the pipeline).