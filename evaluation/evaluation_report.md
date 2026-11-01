# Evaluation report

## Public sample results

Measured by `npm run eval` against the 32 public sample outputs.

| Metric | Result |
|---|---:|
| Deletion-status accuracy | 100.0% (32/32) |
| Exact row accuracy | 31.3% (10/32) |
| Step precision | 100.0% (161/161) |
| Step recall | 83.4% (161/193) |
| Step F1 | 91.0% |
| Sequence accuracy | 31.3% (10/32) |

Per-field accuracy, compared by ordered step position:

| Field | Accuracy |
|---|---:|
| `step_no` | 83.4% (161/193) |
| `phase` | 83.4% (161/193) |
| `system_id` | 64.2% (124/193) |
| `resource_id` | 64.2% (124/193) |
| `operation` | 69.4% (134/193) |
| `state` | 69.4% (134/193) |
| `evidence_id` | 83.4% (161/193) |

Fields are compared by ordered step position, so one missing step shifts every
later step and lowers `system_id`/`operation`/`state` accuracy; precision is
100% (161/161), so no emitted step is wrong and all loss is missing steps
(recall 83.4%).

## Additional synthetic cases

Four author-written cases are exercised by
[`custom_cases.test.js`](./custom_cases.test.js):

| Scenario | Expected behavior | Result |
|---|---|---|
| Historical address after an account email change | Resolve the historical identifier exactly and plan deletion of a linked search record. | Pass |
| Active synchronization flow and restorable backup | Disable the flow and block restore before changing records. | Pass |
| Redacted tombstone and retained security record | Verify both the tombstone treatment and policy-required retained record. | Pass |
| Non-deletion question containing deletion wording | Return `NOT_APPLICABLE`. | Pass |

These four cases call the identity, intent and plan modules directly with in-memory data, so they run without the dataset (4 of 4 passed with no dataset present); they do not exercise evidence extraction or footprint linking.

The full test command passed 83 tests across 7 test files. Without the dataset,
13 tests passed and 70 dataset-dependent tests skipped across 5 passing and 2
skipped test files.

## Failures found and improvements

- Missing steps remain the largest source of exact-row and sequence errors; the
  implementation does not infer a subject link when evidence lacks an exact
  identifier.
- Score progression: step F1 86.6% (precision 96.2%, recall 78.8%), then 90.0%
  (precision 100%) after the support attachment/message, analytics
  contact/profile and evidence-selection fixes, then 91.0% after PDF parsing;
  status accuracy was 31/32, then 32/32 after PDF parsing.
- Evidence selection uses only evidence at or before `audit_at`, preferring an
  explicit resource fact and falling back to the latest eligible covering
  snapshot.
- Support attachments and shared messages use different policy treatments;
  classification depends on explicit category, message, and attachment facts.
- PDF text extraction and tightened intent handling are included in the
  deterministic pipeline.

## Limitations

- The evidence coverage test measured exact-identifier links for 79 of 111
  sample case/resource pairs. Some unlinked `account_*` and `audit_record_*`
  resources are missed.
- The rules were tuned on these same 32 samples, so these results do not
  estimate accuracy on unseen data.
- All 32 samples are deletion requests, so `NOT_APPLICABLE` has no ground-truth
  score.
- Non-deletion detection: text rules alone caught 5 of the 10 non-deletion
  requests, then 8, then 9 after successive pattern fixes, and the text rules
  are brittle. The full run now flags exactly 10, the same 10 requests that
  carry a `CLASSIFY_REQUEST` event in the activity log. This is agreement with
  that activity data, not a scored result. The activity rule itself fired for
  only 1 of them, so it is a weak independent check.
- Per-category miss counts for `account_*` and `audit_record_*` were not
  measured.
- A timestamp-linking experiment was rejected: only 3 of
  25 candidate links were unique in a 5-minute window, 7 of 25 in a 60-minute
  window, and none of 7 audit-record links were unique. This experiment was
  not rerun during packaging.
- Support attachment/message classification remains heuristic when evidence
  does not explicitly identify the record type.

  