// Renders the results report and the whitepaper to shareable PDFs with
// headless Chrome (no extra install). Usage: npm run pdf
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { marked } from "marked";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const REPO = "https://github.com/CopyNinja07-07/zerobleed/blob/main/";

const CSS = `
@page { size: A4; margin: 18mm 16mm; }
body { font: 10.5pt/1.5 Inter, -apple-system, "Segoe UI", sans-serif; color: #1b1726; }
h1 { font-size: 22pt; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 4pt; }
h2 { font-size: 14pt; margin: 18pt 0 6pt; padding-bottom: 3pt; border-bottom: 2px solid #d6f588; }
h3 { font-size: 11.5pt; margin: 12pt 0 4pt; }
p, li { orphans: 3; widows: 3; }
a { color: #4b2f73; text-decoration: none; }
code { font: 8.8pt "JetBrains Mono", Menlo, monospace; background: #f1eef7; padding: 0 3px; border-radius: 3px; }
pre { background: #14101d; color: #ece6f6; padding: 9pt 11pt; border-radius: 6px; font-size: 8.4pt; line-height: 1.45; white-space: pre-wrap; page-break-inside: avoid; }
pre code { background: none; color: inherit; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; font-size: 8.8pt; page-break-inside: auto; }
th, td { border: 1px solid #ddd6e8; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #f4f1f9; }
tr { page-break-inside: avoid; }
blockquote { margin: 8pt 0; padding: 6pt 10pt; border-left: 3px solid #b57edc; background: #faf8fd; color: #3d3550; }
.cover { padding: 6pt 0 10pt; border-bottom: 1px solid #ddd6e8; margin-bottom: 12pt; }
.cover .tag { font: 600 8pt "JetBrains Mono", monospace; letter-spacing: .14em; text-transform: uppercase; color: #6e8540; }
`;

function render(src: string, out: string, title: string) {
  let md = readFileSync(src, "utf8");
  // Links to files in the repo become GitHub links, so they work from a PDF.
  md = md.replace(/\]\((?!https?:|#)(\.\.\/)?([^)]+)\)/g, (_m, _up, p) => `](${REPO}${p})`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=JetBrains+Mono:wght@400;600&display=swap">
<style>${CSS}</style></head><body>
<div class="cover"><div class="tag">ZeroBleed · Open Agent Hackathon 2026 · Track 03</div></div>
${marked.parse(md)}
</body></html>`;
  const tmp = path.resolve(`docs/pdf/.${path.basename(out, ".pdf")}.html`);
  writeFileSync(tmp, html);
  execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--virtual-time-budget=5000", `--print-to-pdf=${path.resolve(out)}`, `file://${tmp}`], { stdio: "ignore" });
  console.log(`wrote ${out}`);
}

mkdirSync("docs/pdf", { recursive: true });
render("RESULTS.md", "docs/pdf/ZeroBleed-Results-Report.pdf", "ZeroBleed Results Report");
render("docs/WHITEPAPER.md", "docs/pdf/ZeroBleed-Whitepaper.pdf", "ZeroBleed Whitepaper");
