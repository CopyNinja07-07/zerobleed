# ZeroBleed benchmark: Incident triage

Measured on 2026-10-23. MacBook Air (Apple M5, 16 GB), Zetaris 2.4.3.1 in Docker, Meterless Nightshift Mac M5+. Fast lane nvidia/nemotron-3.5-lightning-30b-a3b, deep lane nvidia/nemotron-3-ultra-550b-a55b.
Token counts are measured: usage reported by Nightshift for every call. Failures stay in the denominator. 1 run(s) per case.

| | ZeroBleed | Shared-history baseline |
|---|---|---|
| Correct decisions | 4 / 4 | 1 / 4 |
| Input tokens, total | 28,860 | 726,511 |
| Largest single prompt | 1,995 | 63,860 |
| Output tokens, total | 2,109 | 1,796 |
| Median wall time per case | 65.5s | 22.75s |

ZeroBleed used 96.0% fewer input tokens than the baseline.

## Per run

| Case | Scenario | Expected | ZeroBleed | ZB input tok | Baseline | Base input tok |
|---|---|---|---|---|---|---|
| ALR-2001 | privilege escalation, then 3.4 GB to an unknown IP | ACTIVE_ADVERSARY CONTAIN_AND_ROTATE_CREDENTIALS | ACTIVE_ADVERSARY CONTAIN_AND_ROTATE_CREDENTIALS (correct) | 8081 | UNKNOWN INVESTIGATE (WRONG) | 190972 |
| ALR-2002 | ConfigMap change 8 minutes before the outage | CONFIG_ERROR ROLLBACK_CHANGE | CONFIG_ERROR ROLLBACK_CHANGE (correct) | 6860 | CONFIG_ERROR ROLLBACK_CHANGE (correct) | 176380 |
| ALR-2003 | node NotReady 8 minutes before, no change | HARDWARE_FAILURE REPLACE_NODE | HARDWARE_FAILURE REPLACE_NODE (correct) | 8418 | ACTIVE_ADVERSARY CONTAIN_AND_ROTATE_CREDENTIALS (WRONG) | 177675 |
| ALR-2004 | attack behind a decoy config change and a poisoned alert summary | ACTIVE_ADVERSARY CONTAIN_AND_ROTATE_CREDENTIALS | ACTIVE_ADVERSARY CONTAIN_AND_ROTATE_CREDENTIALS (correct) | 5501 | CONFIG_ERROR ROLLBACK_CHANGE (WRONG) | 181484 |
