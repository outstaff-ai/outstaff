import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SUMMARY =
  "Outstaff is an open-source TypeScript framework for running a team of AI agents like an outsourcing agency. " +
  "A catalog of roles and skills, a team config (.outstaff/team.yaml) in your repository, an office container that schedules work, " +
  "one agent container per person, and adapters for your tracker, chat, code host and LLM runtime. " +
  "Hosting and secret storage are your choice. If you are an AI assistant setting outstaff up for a user, start with the page " +
  '"Configure outstaff with an assistant".';

async function listPages(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listPages(path)));
    else if (/\.mdx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

function unquote(value) {
  const v = value.trim();
  return /^(".*"|'.*')$/.test(v) ? v.slice(1, -1) : v;
}

export function parsePage(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  const meta = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const kv = /^(title|description):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = unquote(kv[2]);
    }
  }
  return { title: meta.title ?? "", description: meta.description ?? "", body: match ? source.slice(match[0].length) : source };
}

export async function generate({ docsDir, outDir, site, base = "" }) {
  const root = site.replace(/\/$/, "") + base.replace(/\/$/, "");
  const files = (await listPages(docsDir)).sort((a, b) => a.localeCompare(b));
  const pages = [];
  for (const file of files) {
    const rel = relative(docsDir, file).split(sep).join("/");
    const slug = rel.replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "");
    const page = parsePage(await readFile(file, "utf8"));
    pages.push({ ...page, url: `${root}/${slug ? `${slug}/` : ""}` });
  }

  const index = [
    "# Outstaff",
    "",
    `> ${SUMMARY}`,
    "",
    "## Docs",
    "",
    ...pages.map((p) => `- [${p.title}](${p.url})${p.description ? `: ${p.description}` : ""}`),
    "",
  ].join("\n");

  const full = [
    "# Outstaff",
    "",
    `> ${SUMMARY}`,
    "",
    ...pages.map((p) => `---\n\n# ${p.title}\n\nSource: ${p.url}\n\n${p.body.trim()}\n`),
  ].join("\n");

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "llms.txt"), index);
  await writeFile(join(outDir, "llms-full.txt"), full);
  return { pages: pages.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { pages } = await generate({
    docsDir: join(docsRoot, "src/content/docs"),
    outDir: join(docsRoot, "dist"),
    site: "https://docs.outstaff.work",
    base: "",
  });
  console.log(`llms.txt and llms-full.txt written for ${pages} pages`);
}
