import type { PmNode } from "@outstaff/integration.shared.itsaplan";

// --- editor positions, for anchored comments

function size(node: PmNode): number {
  if (node.type === "text") {
    return node.text?.length ?? 0;
  }

  if (!node.content && ["hardBreak", "horizontalRule", "image"].includes(node.type)) {
    return 1;
  }

  return 2 + (node.content ?? []).reduce((n, c) => n + size(c), 0);
}

function walk(node: PmNode, pos: number, out: [number, string][]): void {
  const kids = node.content ?? [];
  if (kids.length && kids.every((k) => k.type === "text" || k.type === "hardBreak")) {
    out.push([pos + 1, kids.map((k) => (k.type === "text" ? (k.text ?? "") : "\n")).join("")]);
    return;
  }

  let p = pos + 1;
  for (const k of kids) {
    walk(k, p, out);
    p += size(k);
  }
}

function textBlocks(doc: PmNode): [number, string][] {
  const out: [number, string][] = [];
  let p = 0;
  for (const k of doc.content ?? []) {
    walk(k, p, out);
    p += size(k);
  }

  return out;
}

/** Editor positions (UTF-16 units, as ProseMirror counts) of the first occurrence of `quote` inside one text block. */
export function findRange(doc: PmNode, quote: string): [number, number] | undefined {
  for (const [start, t] of textBlocks(doc)) {
    const j = t.indexOf(quote);
    if (j >= 0) {
      return [start + j, start + j + quote.length];
    }
  }

  return undefined;
}

/** The text of every block that holds text, in order. */
export function plainText(doc: PmNode): string[] {
  return textBlocks(doc).map(([, t]) => t);
}
