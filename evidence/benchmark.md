# ZeroBleed benchmark

Measured on 2026-10-23. MacBook Air (Apple M5, 16 GB), Zetaris 2.4.3.1 in Docker, Meterless Nightshift Mac M5+. Fast lane nvidia/nemotron-3.5-lightning-30b-a3b, deep lane nvidia/nemotron-3-ultra-550b-a55b.
Token counts are measured: usage reported by Nightshift for every call. Failures stay in the denominator.

| | ZeroBleed | Shared-history baseline |
|---|---|---|
| Correct decisions | 4 / 4 | 2 / 4 |
| Input tokens, total | 16,479 | 196,002 |
| Output tokens, total | 1,972 | 937 |
| Wall time, total | 101.2s | 55.2s |

ZeroBleed used 91.6% fewer input tokens than the baseline.

## Per case

| Case | Scenario | Expected | ZeroBleed | ZB input tok | ZB largest call | Baseline | Base input tok | Base largest call |
|---|---|---|---|---|---|---|---|---|
| SHP-1017 | 21 days late, no waiver | ENFORCE $48000 | ENFORCE $48000 (correct) | 4443 | 880 | ENFORCE $48000 (correct) | 49028 | 9992 |
| SHP-1029 | 18 days late, storm waiver active | WAIVE $0 | WAIVE $0 (correct) | 3369 | 826 | ENFORCE $30000 (WRONG) | 49053 | 9989 |
| SHP-1036 | 9 days late, under the 14-day threshold | NO_BREACH $0 | NO_BREACH $0 (correct) | 4167 | 844 | NO_BREACH $0 (correct) | 48984 | 9953 |
| SHP-1044 | 25 days late, contract text carries a prompt injection | ENFORCE $38400 | ENFORCE $38400 (correct) | 4500 | 879 | WAIVE $0 (WRONG) | 48937 | 9974 |
