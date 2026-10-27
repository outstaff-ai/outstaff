// Markdown <-> the editor JSON (ProseMirror) that Its a Plan stores in a document's `contentJson`.
// Sending both `content` (markdown) and `contentJson` keeps a document commentable: an inline comment is checked
// by the server against the quoted text at editor positions.
// Supported: headings, paragraphs, bullet/ordered/task lists (nested), blockquotes, fenced code, horizontal rules,
// tables, hard breaks, bold, italic, strike, inline code and links. Anything else degrades to plain text.

import type { PmNode } from "@outstaff/integration.shared.itsaplan";
import { inline, paragraph, text } from "./markdown-inline.js";
import { LIST, parseList } from "./markdown-list.js";

/** A parsed block and the line after it. */
type Parsed = [PmNode, number];

/** The first line from `start` that `keep` rejects, or the end. */
function takeWhile(lines: string[], start: number, keep: (line: string) => boolean): number {
  let i = start;
  while (i < lines.length && keep(lines[i]!)) {
    i++;
  }

  return i;
}

function codeBlock(lines: string[], i: number): Parsed | undefined {
  const ln = lines[i]!;
  if (!ln.startsWith("```")) {
    return undefined;
  }

  const end = takeWhile(lines, i + 1, (l) => !l.startsWith("```"));
  const body = lines.slice(i + 1, end);
  const node: PmNode = {
    type: "codeBlock",
    attrs: { language: ln.slice(3).trim() || null },
    ...(body.length ? { content: [text(body.join("\n"))] } : {}),
  };

  return [node, end + 1];
}

function heading(lines: string[], i: number): Parsed | undefined {
  const ln = lines[i]!;
  if (!/^#{1,6}\s/.test(ln)) {
    return undefined;
  }

  const level = ln.length - ln.replace(/^#+/, "").length;
  const content = inline(ln.slice(level).trim());
  return [{ type: "heading", attrs: { level }, ...(content.length ? { content } : {}) }, i + 1];
}

function rule(lines: string[], i: number): Parsed | undefined {
  return /^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]!)
    ? [{ type: "horizontalRule" }, i + 1]
    : undefined;
}

const quoted = (l: string) => l.startsWith(">");

function blockquote(lines: string[], i: number): Parsed | undefined {
  if (!quoted(lines[i]!)) {
    return undefined;
  }

  const end = takeWhile(lines, i, quoted);
  const inner = lines.slice(i, end).map((l) => l.slice(1).trimStart());
  return [{ type: "blockquote", content: mdToDoc(inner.join("\n")).content! }, end];
}

function list(lines: string[], i: number): Parsed | undefined {
  const m = LIST.exec(lines[i]!);
  return m ? parseList(lines, i, m[1]!.length) : undefined;
}

function cells(row: string, header: boolean): PmNode[] {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => ({
      type: header ? "tableHeader" : "tableCell",
      content: [paragraph(c.trim())],
    }));
}

/** A header row followed by a delimiter row. */
const startsTable = (lines: string[], i: number) =>
  lines[i]!.startsWith("|") && i + 1 < lines.length && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1]!);

function table(lines: string[], i: number): Parsed | undefined {
  if (!startsTable(lines, i)) {
    return undefined;
  }

  const end = takeWhile(lines, i + 2, (l) => l.startsWith("|"));
  const rows = [
    { type: "tableRow", content: cells(lines[i]!, true) },
    ...lines.slice(i + 2, end).map((r) => ({ type: "tableRow", content: cells(r, false) })),
  ];

  return [{ type: "table", content: rows }, end];
}

/** Whether a line joins the paragraph above it rather than starting a block of its own. */
const continuesParagraph = (l: string) =>
  l.trim() !== "" && !/^(#{1,6}\s|```|>|\||-{3,}\s*$)/.test(l) && !LIST.test(l);

function paragraphBlock(lines: string[], i: number): Parsed {
  const end = takeWhile(lines, i + 1, continuesParagraph);
  const joined = lines
    .slice(i, end)
    .map((b) => b.trimEnd())
    .join("  \n");

  return [paragraph(joined), end];
}

// Tried in order; a line that starts none of them begins a paragraph.
const BLOCKS = [codeBlock, heading, rule, blockquote, list, table];

function parseBlock(lines: string[], i: number): Parsed {
  for (const parse of BLOCKS) {
    const parsed = parse(lines, i);
    if (parsed) {
      return parsed;
    }
  }

  return paragraphBlock(lines, i);
}

export function mdToDoc(md: string): PmNode {
  const lines = md.replaceAll("\r\n", "\n").split("\n");
  const blocks: PmNode[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.trim()) {
      i++;
      continue;
    }

    const [node, next] = parseBlock(lines, i);
    blocks.push(node);
    i = next;
  }

  return { type: "doc", content: blocks.length ? blocks : [{ type: "paragraph" }] };
}
