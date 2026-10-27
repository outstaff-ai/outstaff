import { describe, expect, it } from "vitest";
import { docToMd } from "../doc-to-md.js";
import { mdToDoc } from "../markdown.js";
import { findRange, plainText } from "../text-range.js";
import type { PmNode } from "../types.js";

/** The node at the given content indexes, or undefined where the path runs out. */
const nodeAt = (node: PmNode | undefined, ...path: number[]): PmNode | undefined =>
  path.reduce<PmNode | undefined>((n, i) => n?.content?.[i], node);

/** The types of a node's children. */
const childTypes = (node: PmNode | undefined) => node?.content?.map((b) => b.type);

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
    expect(childTypes(doc)).toEqual(["bulletList", "orderedList", "taskList"]);
    expect(childTypes(nodeAt(doc, 0, 0))).toEqual(["paragraph", "bulletList"]);
    expect(nodeAt(doc, 2)?.content?.map((i) => i.attrs?.["checked"])).toEqual([true, false]);
  });

  it("builds code blocks, rules, quotes and tables", () => {
    const doc = mdToDoc(
      "```ts\nconst a = 1;\n```\n\n---\n\n> quoted\n\n| a | b |\n| - | - |\n| 1 | 2 |",
    );

    expect(childTypes(doc)).toEqual(["codeBlock", "horizontalRule", "blockquote", "table"]);
    expect(nodeAt(doc, 0)?.attrs).toEqual({ language: "ts" });
    expect(nodeAt(doc, 3, 0, 0)?.type).toBe("tableHeader");
    expect(nodeAt(doc, 3, 1, 1)?.type).toBe("tableCell");
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

describe("mdToDoc edge cases", () => {
  it("starts a paragraph with a mark and keeps empty cells and empty headings empty", () => {
    const doc = mdToDoc("**lead** text\n\n#  \n\n| a |  |\n| - | - |");
    expect(nodeAt(doc, 0, 0)).toEqual({
      type: "text",
      text: "lead",
      marks: [{ type: "bold" }],
    });

    expect(nodeAt(doc, 1)).toEqual({ type: "heading", attrs: { level: 1 } });
    expect(nodeAt(doc, 2, 0, 1)).toEqual({
      type: "tableHeader",
      content: [{ type: "paragraph" }],
    });
  });

  it("keeps an empty fenced block without content", () => {
    expect(mdToDoc("```\n```").content).toEqual([{ type: "codeBlock", attrs: { language: null } }]);
  });

  it("joins an indented continuation line to its list item, also when the item itself is empty", () => {
    const wrapped = nodeAt(mdToDoc("- one\n  more text"), 0, 0, 0);
    expect(wrapped?.content?.map((n) => n.text)).toEqual(["one", " more text"]);

    const empty = nodeAt(mdToDoc("- \n  later"), 0, 0, 0);
    expect(empty?.content?.map((n) => n.text)).toEqual([" later"]);
  });

  it("ends a list at an indented blank line", () => {
    const doc = mdToDoc("- a\n  \n- b");
    expect(doc.content?.map((b) => b.type)).toEqual(["bulletList", "bulletList"]);
  });
});

describe("docToMd of documents the editor may produce", () => {
  const para = (...content: PmNode[]): PmNode => ({ type: "paragraph", content });
  const doc = (...content: PmNode[]): PmNode => ({ type: "doc", content });

  it("drops marks it does not know and writes a link without a target as an empty one", () => {
    const md = docToMd(
      doc(
        para(
          { type: "text", text: "u", marks: [{ type: "underline" }] },
          { type: "text", text: " l", marks: [{ type: "link" }] },
        ),
      ),
    );

    expect(md).toBe("u[ l]()");
  });

  it("writes a node without text as nothing", () => {
    expect(docToMd(doc(para({ type: "text", text: "a" }, { type: "image" })))).toBe("a");
  });

  it("copes with containers that have no content", () => {
    expect(docToMd({ type: "doc" })).toBe("");
    expect(docToMd(doc({ type: "heading" }))).toBe("# ");
    expect(docToMd(doc({ type: "bulletList" }, para({ type: "text", text: "x" })))).toBe("x");
    expect(docToMd(doc({ type: "bulletList", content: [{ type: "listItem" }] }))).toBe("- ");
    expect(docToMd(doc({ type: "blockquote" }))).toBe(">");
    expect(
      docToMd(doc({ type: "codeBlock", attrs: { language: 3 }, content: [{ type: "text" }] })),
    ).toBe("```\n```");

    expect(docToMd(doc({ type: "codeBlock" }))).toBe("```\n```");
    expect(docToMd(doc({ type: "table" }))).toBe("| --- |");
    expect(
      docToMd(
        doc({ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell" }] }] }),
      ),
    ).toBe("|  |\n| --- |");

    expect(docToMd(doc({ type: "table", content: [{ type: "tableRow" }] }))).toBe("|  |\n| --- |");
  });
});

describe("editor positions of nodes without text", () => {
  it("counts a leaf node as one position and a container as two plus its content", () => {
    const rule = mdToDoc("one\n\n---\n\ntwo");
    expect(findRange(rule, "two")).toEqual([7, 10]);

    const hard: PmNode = {
      type: "doc",
      content: [
        { type: "image" },
        { type: "mystery" },
        { type: "paragraph", content: [{ type: "text", text: "x" }] },
      ],
    };

    expect(findRange(hard, "x")).toEqual([4, 5]);
  });

  it("reads a hard break as a newline and a text node without text as empty", () => {
    const doc: PmNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text" }],
        },
      ],
    };

    expect(plainText(doc)).toEqual(["a\n"]);
    expect(findRange(doc, "\n")).toEqual([2, 3]);
    expect(plainText({ type: "doc" })).toEqual([]);
  });
});
