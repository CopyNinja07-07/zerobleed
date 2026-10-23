# ZeroBleed: sponsor technology explanation

**Zetaris (data layer).** All data lives in Zetaris and never enters a prompt. We registered eight enterprise sources as Lightning REST tables and flattened them into SchemaStore views:
- **Procurement:** shipments, contracts and weather waivers.
- **Incident triage:** about 20,000 CloudTrail, VPC flow and Kubernetes rows, plus alerts and runbooks.

Zetaris SQL also computes the per-alert `alert_signals` view (privilege escalations, gigabytes sent outside the allowlist, config changes and NotReady nodes in the last 30–60 minutes). Our agent uses Zetaris three ways:
1. It reads the **catalog** (`DESCRIBE`): column names only. The planner sees nothing else.
2. It runs **scoped single-cell queries** over the REST SQL API, with the row key computed by code.
3. It uses the catalog as a **security boundary**: a worker may request a missing fact only by naming a catalog column, and the broker rejects anything else.

Every fact in a decision links to the exact Zetaris query that produced it. Code: `src/zetaris.ts`, `src/broker/catalog.ts`, `scripts/setupZetaris.ts`.

**Meterless Engine: Markovian (implemented, tested).** Every decision runs as a Markovian chain of bounded chunks:
- **Carryover:** the engine's carryover state block is our verified-fact scratchpad (under 500 characters).
- **Interrupts:** its `[NEEDS_TOOL]` pause carries ZeroBleed's catalog-constrained interrupt. The broker gates the request, fetches one Zetaris cell, and the engine injects it as `[TOOL_RESULT]`.
- **Reflection:** its reflection pass is our independent reviewer, which ratifies or questions the decision.

We vendored the Meterless reference implementation (Apache 2.0) and extended it with the tool-pause path and per-chunk provider usage. The extensions are marked in the code and listed in `NOTICE.md`. **Test:** the official Markovian conformance suite passes **8/8** (`npm run conformance`, `evidence/markovian-conformance.txt`). Code: `src/engines/markovian/`, `src/broker/broker.ts`.

**Meterless Nightshift (primary AI provider).** Nightshift is the app's only AI provider. Every model call goes through the Nightshift Runtime, following the official contract:
- OpenAI-compatible requests, `Authorization: Bearer` with the Runtime token, the `meterless-app` header, and `meterless-scope: user`.
- Base URL normalised to `<host>/v1`, and a 180 s timeout.
- `GET /v1/models` as the online, unauthorized or offline check. It shows as live status lights in the dashboard and in `/health`.

Each response's usage and compute receipt ID is recorded, so every model call in our results can be looked up in Nightshift's Receipts view. Code: `src/llm.ts`.

**NVIDIA.** Two Nemotron models, connected as a provider inside Nightshift. The NVIDIA key lives only in Nightshift's Providers tab.
- **Nemotron 3.5 Lightning 30B** (reasoning off) handles the cheap, fast steps: extraction, rule checking and the reflection review.
- **Nemotron 3 Ultra 550B** plans from the schema, takes over escalated steps, and makes the final decision.

Models are called by exact name, never `meterless/auto`, and every trace line records which Nemotron model handled the request.

**Cursor (with Space XAI).** Code was edited in Cursor, with AI-assisted coding. The coding tools never received the Nightshift or NVIDIA keys.

**What is unique.** We used the sponsor stack to build a *context firewall*, not just a pipeline:
- **Zetaris** is both the data platform and the gatekeeper. Its catalog defines what an AI is allowed to ask for, and its SQL turns raw telemetry into signals so no model reads a raw log line.
- **The Markovian engine's** carryover and tool-pause become a verified scratchpad and a schema-constrained interrupt. Free text never flows back from a worker, so injected instructions can't reach the decider.
- **Nightshift** lets small and large Nemotron models split the work: the small one does most steps, the large one only plans and decides.

**Measured result** (receipts and traces for every run in `RESULTS.md`):

| Domain | ZeroBleed correct | Shared-history agent correct | Fewer input tokens |
|---|---|---|---|
| Supplier penalties | 4/4 | 3/4 | 91.3% |
| Incident triage | 4/4 | 1/4 | 96.0% |
