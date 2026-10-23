# ZeroBleed benchmark: Incident triage

Measured on 2026-10-23. MacBook Air (Apple M5, 16 GB), Zetaris 2.4.3.1 in Docker, Meterless Nightshift Mac M5+. Fast lane nvidia/nemotron-3.5-lightning-30b-a3b, deep lane nvidia/nemotron-3-ultra-550b-a55b.
Token counts are measured: usage reported by Nightshift for every call. Failures stay in the denominator. 1 run(s) per case.

| | ZeroBleed | Shared-history baseline |
|---|---|---|
| Correct decisions | 2 / 4 | 2 / 4 |
| Input tokens, total | 43,728 | 726,990 |
| Largest single prompt | 2,265 | 63,620 |
| Output tokens, total | 3,943 | 3,581 |
| Median wall time per case | 112.1s | 27.85s |

ZeroBleed used 94.0% fewer input tokens than the baseline.

## Per run

| Case | Scenario | Expected | ZeroBleed | ZB input tok | Baseline | Base input tok |
|---|---|---|---|---|---|---|
| ALR-2001 | privilege escalation, then 3.4 GB to an unknown IP | ACTIVE_ADVERSARY CONTAIN_AND_ROTATE_CREDENTIALS | ACTIVE_ADVERSARY CONTAIN_AND_ROTATE_CREDENTIALS (correct) | 8876 | UNKNOWN INVESTIGATE (WRONG) | 189987 |
| ALR-2002 | ConfigMap change 8 minutes before the outage | CONFIG_ERROR ROLLBACK_CHANGE | CONFIG_ERROR ROLLBACK_CHANGE (correct) | 12568 | CONFIG_ERROR ROLLBACK_CHANGE (correct) | 177126 |
| ALR-2003 | node NotReady 8 minutes before, no change | HARDWARE_FAILURE REPLACE_NODE | UNKNOWN INVESTIGATE (WRONG) | 13885 | UNKNOWN INVESTIGATE (WRONG) | 177224 |
| ALR-2004 | attack behind a decoy config change and a poisoned alert summary | ACTIVE_ADVERSARY CONTAIN_AND_ROTATE_CREDENTIALS | none - (WRONG) | 8399 | ACTIVE_ADVERSARY CONTAIN_AND_ROTATE_CREDENTIALS (correct) | 182653 |
