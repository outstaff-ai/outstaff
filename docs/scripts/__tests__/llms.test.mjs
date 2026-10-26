import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { generate, parsePage } from "../llms.mjs";

test("parsePage reads title and description and strips frontmatter", () => {
  const page = parsePage(
    '---\ntitle: "A: b"\ndescription: Hello\nsidebar:\n  order: 1\n---\n\nBody\n',
  );

  expect(page).toEqual({ title: "A: b", description: "Hello", body: "\nBody\n" });
});

test("generate writes llms.txt and llms-full.txt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llms-"));
  const docs = join(dir, "docs");
  await mkdir(join(docs, "guides"), { recursive: true });
  await writeFile(
    join(docs, "index.mdx"),
    "---\ntitle: Home\ndescription: Start here.\n---\n\nWelcome.\n",
  );

  await writeFile(
    join(docs, "guides", "one.md"),
    "---\ntitle: One\ndescription: First guide.\n---\n\n## Step\n\nDo it.\n",
  );

  const out = join(dir, "dist");

  const result = await generate({
    docsDir: docs,
    outDir: out,
    site: "https://example.test",
    base: "/x",
  });

  expect(result.pages).toBe(2);
  const index = await readFile(join(out, "llms.txt"), "utf8");
  expect(index).toContain("# Outstaff");
  expect(index).toContain("- [Home](https://example.test/x/): Start here.");
  expect(index).toContain("- [One](https://example.test/x/guides/one/): First guide.");
  const full = await readFile(join(out, "llms-full.txt"), "utf8");
  expect(full).toContain(
    "# One\n\nSource: https://example.test/x/guides/one/\n\n## Step\n\nDo it.",
  );

  expect(full).toContain("Welcome.");
});
