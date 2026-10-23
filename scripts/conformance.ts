// Runs the official Markovian conformance suite against ZeroBleed's engine and
// saves the scorecard to evidence/ for the submission.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const impl = path.resolve("src/engines/markovian/index.ts");
let out = "";
let code = 0;
try {
  out = execFileSync(process.execPath, ["--import", "tsx", "vendor/markovian-conformance/runner.ts"], {
    env: { ...process.env, MARKOVIAN_IMPL: impl },
    encoding: "utf8",
  });
} catch (err: any) {
  out = String(err.stdout ?? "") + String(err.stderr ?? "");
  code = err.status ?? 1;
}
console.log(out.trim());
mkdirSync("evidence", { recursive: true });
writeFileSync("evidence/markovian-conformance.txt", `${new Date().toISOString()}\n${out.replace(impl, "src/engines/markovian/index.ts")}`);
process.exit(code);
