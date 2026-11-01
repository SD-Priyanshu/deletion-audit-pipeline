# Deletion audit conventions

## Decision and evidence rules

- Authorize deletion only when the request actually asks for account or personal-data deletion. Access, correction, export, and marketing opt-out requests are not deletion requests.
- Resolve current and historical identifiers by exact normalized equality. Do not infer identity from timestamps, similar strings, or unrelated activity.
- Reconstruct state using evidence available no later than `audit_at`; workflow statuses and activity results are claims, not proof.
- Prefer the latest evidence that explicitly describes a resource at or before `audit_at`. If none does, use the latest eligible snapshot that covers the relevant system.
- Keep evidence citations on findings and existing-state verifications. Proposed remediation and future verification have no evidence citation.
- A deletion is complete only when all relevant copies have the required treatment and no active flow or restore path can recreate prohibited data.

## Policy matrix

| Data category | Required treatment | Finding when noncompliant | Remediation | Verification |
|---|---|---|---|---|
| User profile, secondary identifier, search entry, cache entry, user export, marketing profile | Delete | `REPORT_REMAINING_RECORD` / `PRESENT` | `DELETE_RECORD` / `ABSENT` | `VERIFY_RECORD_ABSENT` / `ABSENT` |
| Support attachment belonging only to the subject | Delete | `REPORT_REMAINING_RECORD` / `PRESENT` | `DELETE_RECORD` / `ABSENT` | `VERIFY_RECORD_ABSENT` / `ABSENT` |
| Shared support message | Redact identifying fields; retain shared context | `REPORT_EXPOSED_PII` / `PRESENT` | `REDACT_RECORD` / `REDACTED` | `VERIFY_RECORD_REDACTED` / `REDACTED` |
| Attributable analytics profile or product telemetry | Anonymize | `REPORT_EXPOSED_PII` / `PRESENT` | `ANONYMIZE_RECORD` / `ANONYMIZED` | `VERIFY_RECORD_ANONYMIZED` / `ANONYMIZED` |
| Email-delivery log containing a direct address | Redact | `REPORT_EXPOSED_PII` / `PRESENT` | `REDACT_RECORD` / `REDACTED` | `VERIFY_RECORD_REDACTED` / `REDACTED` |
| Security audit log within retention or active legal-hold record | Retain | None | None | `VERIFY_RECORD_PRESENT` / `PRESENT` |
| Backup archive | Retain; block restore access | `REPORT_RESTORE_RISK` / `ACTIVE` | `BLOCK_RESTORE` / `BLOCKED` | `VERIFY_RESTORE_BLOCKED` / `BLOCKED` |
| Account tombstone | Keep the stable subject reference; remove name, email, phone, and email hash | `REPORT_EXPOSED_PII` / `PRESENT` | `REDACT_RECORD` / `REDACTED` | `VERIFY_RECORD_REDACTED` / `REDACTED` |
| Active synchronization or import flow | Disable | `REPORT_ACTIVE_DATA_FLOW` / `ACTIVE` | `DISABLE_DATA_FLOW` / `DISABLED` | `VERIFY_DATA_FLOW_DISABLED` / `DISABLED` |

## Ordering matrix

| Phase | Operation order |
|---|---|
| Findings | Remaining record, exposed PII, active data flow, restore risk |
| Remediation | Disable data flow, block restore, delete record, redact record, anonymize record |
| Verification | Record absent, record present, record redacted, record anonymized, data flow disabled, restore blocked |

Within an operation, sort by `system_id` and then `resource_id` using ascending string order. Findings precede remediation, which precedes verification. Handle downstream copies before their source when a dependency requires it.
