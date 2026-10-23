import { describe, expect, it } from "vitest";
import { splitMrkdwn, toMrkdwn } from "./mrkdwn.js";

describe("toMrkdwn goldens", () => {
  const cases: [string, string, string][] = [
    ["bold", "a **bold** and __also__ word", "a *bold* and *also* word"],
    ["italics", "an *italic* and _kept_ word", "an _italic_ and _kept_ word"],
    ["strikethrough", "~~gone~~", "~gone~"],
    [
      "links",
      "see [the docs](https://acme.example/a?x=1&y=2)",
      "see <https://acme.example/a?x=1&amp;y=2|the docs>",
    ],
    ["link with bold label", "[**go**](https://acme.example)", "<https://acme.example|go>"],
    ["image", "![logo](https://acme.example/l.png)", "<https://acme.example/l.png|logo>"],
    ["autolink", "<https://acme.example>", "<https://acme.example>"],
    ["a non-http link keeps its text", "[x](javascript:alert(1))", "[x](javascript:alert(1))"],
    ["headings become bold lines", "# Title\n### Sub **x**", "*Title*\n*Sub x*"],
    ["bullets", "- one\n* two\n  - nested", "• one\n• two\n  • nested"],
    ["numbered lists stay", "1. one\n2. two", "1. one\n2. two"],
    ["task lists", "- [ ] todo\n- [x] done", "• ☐ todo\n• ☑ done"],
    ["quotes", "> quoted **text**", "> quoted *text*"],
    ["rules", "---", "──────────"],
    ["escapes", "a < b && c > d", "a &lt; b &amp;&amp; c &gt; d"],
    [
      "inline code is kept",
      "run `a **b** <c>` now",
      "run `a **b** <c>` now".replace("<c>", "&lt;c&gt;"),
    ],
    [
      "fenced code is kept and the language dropped",
      "```ts\nconst a = **b** < 1;\n```",
      "```\nconst a = **b** &lt; 1;\n```",
    ],
    [
      "tables become aligned code blocks",
      "| Name | Role |\n| --- | --- |\n| **Sam** | dev |\n| Noor | pm |",
      "```\nName  Role\nSam   dev\nNoor  pm\n```",
    ],
    [
      "a mixed message",
      "## Status\n\nDone: **ACME-1** ([PR](https://acme.example/pr/1))\n- next: `ACME-2`",
      "*Status*\n\nDone: *ACME-1* (<https://acme.example/pr/1|PR>)\n• next: `ACME-2`",
    ],
  ];

  it.each(cases)("%s", (_name, input, expected) => {
    expect(toMrkdwn(input)).toBe(expected);
  });

  it("keeps a mention of a member and still escapes other angle brackets", () => {
    expect(toMrkdwn("<@U0AB12CD3> done, see <b> and [PR](https://example.test/pr/1)")).toBe(
      "<@U0AB12CD3> done, see &lt;b&gt; and <https://example.test/pr/1|PR>",
    );
  });

  it("is idempotent enough to leave plain text alone", () => {
    expect(toMrkdwn("plain text, nothing special.")).toBe("plain text, nothing special.");
  });
});

describe("splitMrkdwn", () => {
  const line = (i: number) => `line ${i} of the report`;

  it("keeps short text whole", () => {
    expect(splitMrkdwn("short")).toEqual(["short"]);
  });

  it("splits long text at line breaks under the limit", () => {
    const text = Array.from({ length: 400 }, (_, i) => line(i)).join("\n");
    const parts = splitMrkdwn(text, 500);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(500);
      expect(p.startsWith("line ")).toBe(true);
      expect(p.endsWith("report")).toBe(true);
    }

    expect(parts.join("\n")).toBe(text);
  });

  it("closes and reopens a code block cut by the split", () => {
    const code = Array.from({ length: 100 }, (_, i) => `x${i} = ${i};`).join("\n");
    const parts = splitMrkdwn(`intro\n\`\`\`\n${code}\n\`\`\`\noutro`, 300);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(300);
      expect(p.split("\n").filter((l) => l.startsWith("```")).length % 2).toBe(0);
    }

    expect(parts.at(-1)).toMatch(/outro$/);
  });

  it("cuts a single over-long line", () => {
    const parts = splitMrkdwn("a".repeat(1000), 400);
    expect(parts.map((p) => p.length)).toEqual([392, 392, 216]);
  });
});
