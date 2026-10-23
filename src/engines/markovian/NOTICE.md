# Markovian engine (vendored)

This folder is the Markovian reference implementation from the open-source Meterless repository
(https://github.com/Meterless/Meterless, `engines/markovian/reference/src`), licensed under Apache 2.0 (see LICENSE).
It is a pre-existing open-source library, declared as such in the hackathon submission.

ZeroBleed changes, all marked "ZeroBleed extension" in the code:
- `onTool` fulfils `[NEEDS_TOOL ...]` pauses and injects a `[TOOL_RESULT]` block into the next chunk (docs/marker-protocol.md).
- Provider-reported usage is recorded per chunk and summed into `run.measuredTokens`. The engine's efficiency math stays labelled `estimated` (AGENTS.md section 14).
