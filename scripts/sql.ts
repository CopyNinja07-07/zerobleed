// Dev helper: run one SQL statement against Zetaris and print the result.
// Usage: npx tsx scripts/sql.ts "SHOW LIGHTNING DATABASES"
import { runSql } from "../src/zetaris.ts";

const result = await runSql(process.argv[2]);
console.log(JSON.stringify(result, null, 1).slice(0, 4000));
