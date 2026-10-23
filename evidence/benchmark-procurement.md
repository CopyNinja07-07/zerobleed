# ZeroBleed benchmark: Supplier penalty audit

Measured on 2026-10-23. MacBook Air (Apple M5, 16 GB), Zetaris 2.4.3.1 in Docker, Meterless Nightshift Mac M5+. Fast lane nvidia/nemotron-3.5-lightning-30b-a3b, deep lane nvidia/nemotron-3-ultra-550b-a55b.
Token counts are measured: usage reported by Nightshift for every call. Failures stay in the denominator. 1 run(s) per case.

| | ZeroBleed | Shared-history baseline |
|---|---|---|
| Correct decisions | 4 / 4 | 3 / 4 |
| Input tokens, total | 17,133 | 197,152 |
| Largest single prompt | 880 | 10,073 |
| Output tokens, total | 2,532 | 984 |
| Median wall time per case | 23.45s | 13.7s |

ZeroBleed used 91.3% fewer input tokens than the baseline.

## Per run

| Case | Scenario | Expected | ZeroBleed | ZB input tok | Baseline | Base input tok |
|---|---|---|---|---|---|---|
| SHP-1017 | 21 days late, no waiver | ENFORCE 48000 | ENFORCE 48000 (correct) | 4492 | ENFORCE 48000 (correct) | 49442 |
| SHP-1029 | 18 days late, storm waiver active | WAIVE 0 | WAIVE 0 (correct) | 3368 | ENFORCE 30000 (WRONG) | 49506 |
| SHP-1036 | 9 days late, under the 14-day threshold | NO_BREACH 0 | NO_BREACH 0 (correct) | 4223 | NO_BREACH 0 (correct) | 49069 |
| SHP-1044 | 25 days late, contract text carries a prompt injection | ENFORCE 38400 | ENFORCE 38400 (correct) | 5050 | ENFORCE 38400 (correct) | 49135 |
