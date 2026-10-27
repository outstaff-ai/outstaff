// Inline markdown (bold, italic, strike, code, links, hard breaks) to editor JSON text nodes.

import type { Mark, PmNode } from "./types.js";

const LINK_ATTRS = {
  title: null,
  target: "_blank",
  rel: "noopener noreferrer nofollow",
  class: null,
};

export const text = (t: string, marks?: Mark[]): PmNode => ({
  type: "text",
  text: t,
  ...(marks?.length ? { marks } : {}),
});

const INLINE =
  /(\*\*(.+?)\*\*|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![*\w])\*([^*\n]+?)\*(?![*\w])|  \n)/g;

/** The inner text of a marked span and the mark it adds: bold, strike, link or italic. */
function markedSpan(m: RegExpMatchArray): [string, Mark] {
  if (m[2] !== undefined) {
    return [m[2], { type: "bold" }];
  }

  if (m[3] !== undefined) {
    return [m[3], { type: "strike" }];
  }

  if (m[5] !== undefined) {
    return [m[5], { type: "link", attrs: { ...LINK_ATTRS, href: m[6] } }];
  }

  return [m[7]!, { type: "italic" }];
}

/** The nodes of one match of INLINE, inside the given marks. */
function matchNodes(m: RegExpMatchArray, marks: Mark[]): PmNode[] {
  if (m[0] === "  \n") {
    return [{ type: "hardBreak" }];
  }

  if (m[4] !== undefined) {
    return [text(m[4], [{ type: "code" }])];
  }

  const [inner, mark] = markedSpan(m);
  return inline(inner, [...marks, mark]);
}

export function inline(s: string, marks: Mark[] = []): PmNode[] {
  const out: PmNode[] = [];
  let pos = 0;
  for (const m of s.matchAll(INLINE)) {
    const start = m.index;
    if (start > pos) {
      out.push(text(s.slice(pos, start), marks));
    }

    out.push(...matchNodes(m, marks));
    pos = start + m[0].length;
  }

  if (pos < s.length) {
    out.push(text(s.slice(pos), marks));
  }

  return out.filter((n) => n.type !== "text" || n.text);
}

export function paragraph(t: string): PmNode {
  const content = inline(t);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
}
