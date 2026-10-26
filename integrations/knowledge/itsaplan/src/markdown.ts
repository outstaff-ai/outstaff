// Markdown <-> the editor JSON (ProseMirror) that Its a Plan stores in a document's `contentJson`.
// Sending both `content` (markdown) and `contentJson` keeps a document commentable: an inline comment is checked
// by the server against the quoted text at editor positions.
// Supported: headings, paragraphs, bullet/ordered/task lists (nested), blockquotes, fenced code, horizontal rules,
// tables, hard breaks, bold, italic, strike, inline code and links. Anything else degrades to plain text.

import type { Mark, PmNode } from "./types.js";

const LINK_ATTRS = {
  title: null,
  target: "_blank",
  rel: "noopener noreferrer nofollow",
  class: null,
};

const text = (t: string, marks?: Mark[]): PmNode => ({
  type: "text",
  text: t,
  ...(marks?.length ? { marks } : {}),
});

const INLINE =
  /(\*\*(.+?)\*\*|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![*\w])\*([^*\n]+?)\*(?![*\w])|  \n)/g;

export function inline(s: string, marks: Mark[] = []): PmNode[] {
  const out: PmNode[] = [];
  let pos = 0;
  for (const m of s.matchAll(INLINE)) {
    const start = m.index;
    if (start > pos) {
      out.push(text(s.slice(pos, start), marks));
    }

    if (m[0] === "  \n") {
      out.push({ type: "hardBreak" });
    } else if (m[2] !== undefined) {
      out.push(...inline(m[2], [...marks, { type: "bold" }]));
    } else if (m[3] !== undefined) {
      out.push(...inline(m[3], [...marks, { type: "strike" }]));
    } else if (m[4] !== undefined) {
      out.push(text(m[4], [{ type: "code" }]));
    } else if (m[5] !== undefined) {
      out.push(...inline(m[5], [...marks, { type: "link", attrs: { ...LINK_ATTRS, href: m[6] } }]));
    } else {
      out.push(...inline(m[7]!, [...marks, { type: "italic" }]));
    }

    pos = start + m[0].length;
  }

  if (pos < s.length) {
    out.push(text(s.slice(pos), marks));
  }

  return out.filter((n) => n.type !== "text" || n.text);
}

function paragraph(t: string): PmNode {
  const content = inline(t);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
}

const LIST = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const TASK = /^\[( |x|X)\]\s+(.*)$/;

function parseList(lines: string[], start: number, indent: number): [PmNode, number] {
  let i = start;
  const ordered = /\d/.test(LIST.exec(lines[i]!)![2]![0]!);
  const items: PmNode[] = [];
  let task = false;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]!);
    if (!m || m[1]!.length !== indent || /\d/.test(m[2]![0]!) !== ordered) {
      break;
    }

    let body = m[3]!;
    const t = TASK.exec(body);
    if (t) {
      task = true;
      body = t[2]!;
    }

    const blocks: PmNode[] = [paragraph(body)];
    i++;
    while (i < lines.length) {
      const n = LIST.exec(lines[i]!);
      if (n && n[1]!.length > indent) {
        const [sub, next] = parseList(lines, i, n[1]!.length);
        blocks.push(sub);
        i = next;
      } else if (!n && lines[i]!.startsWith(" ".repeat(indent + 2)) && lines[i]!.trim()) {
        const first = blocks[0]!;
        first.content = [...(first.content ?? []), text(` ${lines[i]!.trim()}`)];
        i++;
      } else {
        break;
      }
    }

    items.push(
      task
        ? {
            type: "taskItem",
            attrs: { checked: t !== null && "xX".includes(t[1]!) },
            content: blocks,
          }
        : { type: "listItem", content: blocks },
    );
  }

  return [{ type: task ? "taskList" : ordered ? "orderedList" : "bulletList", content: items }, i];
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

export function mdToDoc(md: string): PmNode {
  const lines = md.replaceAll("\r\n", "\n").split("\n");
  const blocks: PmNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i]!;
    if (!ln.trim()) {
      i++;
    } else if (ln.startsWith("```")) {
      const lang = ln.slice(3).trim() || null;
      i++;
      const buf: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        buf.push(lines[i]!);
        i++;
      }

      i++;
      blocks.push({
        type: "codeBlock",
        attrs: { language: lang },
        ...(buf.length ? { content: [text(buf.join("\n"))] } : {}),
      });
    } else if (/^#{1,6}\s/.test(ln)) {
      const level = ln.length - ln.replace(/^#+/, "").length;
      const content = inline(ln.slice(level).trim());
      blocks.push({ type: "heading", attrs: { level }, ...(content.length ? { content } : {}) });
      i++;
    } else if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) {
      blocks.push({ type: "horizontalRule" });
      i++;
    } else if (ln.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) {
        buf.push(lines[i]!.slice(1).trimStart());
        i++;
      }

      blocks.push({ type: "blockquote", content: mdToDoc(buf.join("\n")).content! });
    } else if (LIST.test(ln)) {
      const [node, next] = parseList(lines, i, LIST.exec(ln)![1]!.length);
      blocks.push(node);
      i = next;
    } else if (
      ln.startsWith("|") &&
      i + 1 < lines.length &&
      /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1]!)
    ) {
      const rows: PmNode[] = [{ type: "tableRow", content: cells(ln, true) }];
      i += 2;
      while (i < lines.length && lines[i]!.startsWith("|")) {
        rows.push({ type: "tableRow", content: cells(lines[i]!, false) });
        i++;
      }

      blocks.push({ type: "table", content: rows });
    } else {
      const buf = [ln];
      i++;
      while (
        i < lines.length &&
        lines[i]!.trim() &&
        !/^(#{1,6}\s|```|>|\||-{3,}\s*$)/.test(lines[i]!) &&
        !LIST.test(lines[i]!)
      ) {
        buf.push(lines[i]!);
        i++;
      }

      blocks.push(paragraph(buf.map((b) => b.trimEnd()).join("  \n")));
    }
  }

  return { type: "doc", content: blocks.length ? blocks : [{ type: "paragraph" }] };
}
