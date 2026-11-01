# Usage report

## Final full-dataset run

`npm run audit` completed in 19.209 seconds and produced 518 rows.

| Measure | Total | Average per request |
|---|---:|---:|
| Requests | 518 | 1 |
| Model provider / model | None used | — |
| Model calls | 0 | 0 |
| Input tokens | 0 | 0 |
| Output tokens | 0 | 0 |
| Total tokens | 0 | 0 |
| Estimated cost (USD) | $0.00 | $0.00 |

| Full-run status | Rows |
|---|---:|
| `COMPLETE` | 163 |
| `INCOMPLETE` | 345 |
| `NOT_APPLICABLE` | 10 |

The pipeline is deterministic and rule-based; no model calls were made. The
`llm_usage` table contained 0 rows after the run. There are no per-model
totals because no model was used.

The fresh-clone test run passed 83 tests across 7 files. In a separate
fresh-clone copy without the dataset, 13 tests passed and 70 dataset-backed
tests skipped across 5 passing and 2 skipped files; `npm run eval` exited with
code 1 and the documented missing-dataset message.
