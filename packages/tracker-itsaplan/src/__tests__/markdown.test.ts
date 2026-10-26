import { describe, expect, it } from "vitest";
import { docToMd, findRange, mdToDoc, plainText } from "../markdown.js";

describe("mdToDoc", () => {
  it("builds headings, paragraphs and inline marks", () => {
    const doc = mdToDoc(
      "# Title\n\nSome **bold**, *italic*, ~~gone~~ and `code` with [a link](https://x.example).",
    );

    expect(doc.content?.[0]).toEqual({
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text: "Title" }],
    });

    const para = doc.content?.[1]?.content ?? [];
    expect(para.map((n) => n.marks?.[0]?.type)).toEqual([
      undefined,
      "bold",
      undefined,
      "italic",
      undefined,
      "strike",
      undefined,
      "code",
      undefined,
      "link",
      undefined,
    ]);

    expect(para[9]?.marks?.[0]?.attrs).toMatchObject({
      href: "https://x.example",
      target: "_blank",
    });
  });

  it("builds nested bullet, ordered and task lists", () => {
    const doc = mdToDoc("- a\n  - b\n- c\n\n1. one\n2. two\n\n- [x] done\n- [ ] todo");
    expect(doc.content?.map((b) => b.type)).toEqual(["bulletList", "orderedList", "taskList"]);
    expect(doc.content?.[0]?.content?.[0]?.content?.map((b) => b.type)).toEqual([
      "paragraph",
      "bulletList",
    ]);

    expect(doc.content?.[2]?.content?.map((i) => i.attrs?.["checked"])).toEqual([true, false]);
  });

  it("builds code blocks, rules, quotes and tables", () => {
    const doc = mdToDoc(
      "```ts\nconst a = 1;\n```\n\n---\n\n> quoted\n\n| a | b |\n| - | - |\n| 1 | 2 |",
    );

    expect(doc.content?.map((b) => b.type)).toEqual([
      "codeBlock",
      "horizontalRule",
      "blockquote",
      "table",
    ]);

    expect(doc.content?.[0]?.attrs).toEqual({ language: "ts" });
    expect(doc.content?.[3]?.content?.[0]?.content?.[0]?.type).toBe("tableHeader");
    expect(doc.content?.[3]?.content?.[1]?.content?.[1]?.type).toBe("tableCell");
  });

  it("gives an empty document one empty paragraph and turns soft breaks into hard breaks", () => {
    expect(mdToDoc("")).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    const para = mdToDoc("one\ntwo").content?.[0]?.content ?? [];
    expect(para.map((n) => n.type)).toEqual(["text", "hardBreak", "text"]);
  });
});

describe("docToMd", () => {
  const samples: Record<string, string> = {
    heading: "## Heading with `code`",
    marks: "Plain **bold** and *italic* and ~~strike~~ and [link](https://x.example/a).",
    nestedMarks: "A **bold [link](https://x.example)** here.",
    bullets: "- one\n  - nested\n  - more\n- two",
    ordered: "1. first\n2. second",
    tasks: "- [x] done\n- [ ] open",
    quote: "> a quote\n>\n> second paragraph",
    code: "```ts\nconst a = 1;\nconst b = 2;\n```",
    rule: "before\n\n---\n\nafter",
    table: "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |",
    hardBreak: "line one  \nline two",
    mixed: "# T\n\nIntro text.\n\n- a\n- b\n\n```\nplain\n```\n\n> note",
  };

  for (const [name, md] of Object.entries(samples)) {
    it(`round-trips ${name}`, () => {
      expect(docToMd(mdToDoc(md))).toBe(md);
      // and the JSON is stable: parsing the output gives the same document
      expect(mdToDoc(docToMd(mdToDoc(md)))).toEqual(mdToDoc(md));
    });
  }

  it("serialises an empty document as an empty string", () => {
    expect(docToMd(mdToDoc(""))).toBe("");
  });
});

describe("findRange", () => {
  it("returns editor positions of a quote inside one text block", () => {
    const doc = mdToDoc("# Title\n\nHello brave new world");
    // heading: 0 open, "Title" at 1..6, close -> paragraph opens at 7, text starts at 8
    expect(findRange(doc, "brave")).toEqual([14, 19]);
    expect(findRange(doc, "Title")).toEqual([1, 6]);
  });

  it("counts list nesting and finds text in later blocks", () => {
    const doc = mdToDoc("intro\n\n- alpha\n- beta gamma");
    const range = findRange(doc, "gamma")!;
    expect(range[1] - range[0]).toBe(5);
    expect(plainText(doc)).toEqual(["intro", "alpha", "beta gamma"]);
  });

  it("returns undefined when the quote spans blocks or is missing", () => {
    const doc = mdToDoc("one\n\ntwo");
    expect(findRange(doc, "one two")).toBeUndefined();
    expect(findRange(doc, "absent")).toBeUndefined();
  });

  it("counts UTF-16 units like the editor", () => {
    const doc = mdToDoc("a😀 target");
    const [from, to] = findRange(doc, "target")!;
    expect(to - from).toBe(6);
    expect(from).toBe(1 + "a😀 ".length);
  });
});
