// Prints coverage per integration as a markdown table, and appends it to the GitHub job summary when there is one.
import { appendFileSync, readFileSync } from "node:fs";

const summary = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8"));
const metrics = ["lines", "branches", "functions", "statements"];
const packages = new Map();

for (const [file, data] of Object.entries(summary)) {
  if (file === "total") {
    continue;
  }

  // Each integration gets a row, and so does the office's event pipeline (decision 0016).
  const name =
    /\/integrations\/([^/]+\/[^/]+)\//.exec(file)?.[1] ??
    (/\/packages\/office\/src\/pipeline\//.test(file) ? "office/pipeline" : undefined);

  if (!name) {
    continue;
  }

  const totals = packages.get(name) ?? Object.fromEntries(metrics.map((m) => [m, [0, 0]]));
  for (const m of metrics) {
    totals[m][0] += data[m].covered;
    totals[m][1] += data[m].total;
  }

  packages.set(name, totals);
}

const pct = ([covered, total]) => (total === 0 ? "100.0" : ((100 * covered) / total).toFixed(1));
const rows = [...packages].sort(([a], [b]) => a.localeCompare(b));
const table = [
  "| Code | Lines | Branches | Functions | Statements |",
  "|---|---|---|---|---|",
  ...rows.map(([name, t]) => `| ${name} | ${metrics.map((m) => pct(t[m])).join(" | ")} |`),
].join("\n");

console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Coverage\n\n${table}\n`);
}
