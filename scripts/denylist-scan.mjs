// Scans tracked files and the PR title/body against a private deny-list.
// Output never includes a pattern or matched text, only locations and pattern numbers.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SKIP_FILES = new Set(["pnpm-lock.yaml"]);

/** One case-insensitive regex per non-empty line. */
export function parsePatterns(raw) {
  const patterns = [];
  const invalid = [];
  raw.split(/\r?\n/).forEach((line) => {
    const source = line.trim();
    if (!source) return;
    const n = patterns.length + invalid.length + 1;
    try {
      patterns.push({ n, re: new RegExp(source, "i") });
    } catch {
      invalid.push(n);
    }
  });
  return { patterns, invalid };
}

/** Returns `{ line, pattern }` for every line that matches a pattern (first pattern per line). */
export function scanText(text, patterns) {
  const hits = [];
  text.split(/\r?\n/).forEach((content, i) => {
    const hit = patterns.find(({ re }) => re.test(content));
    if (hit) hits.push({ line: i + 1, pattern: hit.n });
  });
  return hits;
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function main() {
  const raw = process.env.DENYLIST ?? "";
  if (!raw.trim()) {
    console.log("DENYLIST is empty (expected on forks); skipping deny-list scan.");
    return 0;
  }
  const { patterns, invalid } = parsePatterns(raw);
  let failed = false;
  for (const n of invalid) {
    console.log(`deny-list pattern #${n} is not a valid regular expression`);
    failed = true;
  }

  const report = (where, hits) => {
    for (const { line, pattern } of hits) {
      console.log(`${where}:${line}: matches deny-list pattern #${pattern}`);
      failed = true;
    }
  };

  const files = execFileSync("git", ["ls-files", "-z"], { maxBuffer: 1 << 28 })
    .toString()
    .split("\0")
    .filter((f) => f && !SKIP_FILES.has(f));
  for (const file of files) {
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      continue;
    }
    if (isBinary(buf)) continue;
    report(file, scanText(buf.toString("utf8"), patterns));
  }
  report("PR title", scanText(process.env.PR_TITLE ?? "", patterns));
  report("PR body", scanText(process.env.PR_BODY ?? "", patterns));

  if (failed) console.log("Deny-list scan failed.");
  else console.log(`Deny-list scan passed (${files.length} files).`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
