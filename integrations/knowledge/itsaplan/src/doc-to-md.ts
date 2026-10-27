import type { Mark, PmNode } from "@outstaff/integration.shared.itsaplan";

// --- editor JSON -> markdown

function wrapMark(mark: Mark, inner: string): string {
  switch (mark.type) {
    case "bold":
      return `**${inner}**`;
    case "italic":
      return `*${inner}*`;
    case "strike":
      return `~~${inner}~~`;
    case "code":
      return `\`${inner}\``;
    case "link":
      return `[${inner}](${String(mark.attrs?.["href"] ?? "")})`;
    default:
      return inner;
  }
}

const sameMark = (a: Mark | undefined, b: Mark | undefined) =>
  a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);

/** The index after the run of nodes, from `start`, whose outermost mark is `outer`. */
function runEnd(nodes: PmNode[], start: number, outer: Mark): number {
  let i = start;
  while (i < nodes.length && sameMark(nodes[i]!.marks?.[0], outer)) {
    i++;
  }

  return i;
}

/** The markdown of the node at `i`, with any neighbours wrapped in the same outer mark, and the index after it. */
function inlineRun(nodes: PmNode[], i: number): [string, number] {
  const node = nodes[i]!;
  if (node.type === "hardBreak") {
    return ["  \n", i + 1];
  }

  const outer = node.marks?.[0];
  if (!outer) {
    return [node.text ?? "", i + 1];
  }

  const end = runEnd(nodes, i, outer);
  const run = nodes.slice(i, end).map((n) => ({ ...n, marks: n.marks!.slice(1) }));
  return [wrapMark(outer, inlineMd(run)), end];
}

// Marks are listed outermost first; neighbours that share their outer mark are wrapped together.
function inlineMd(nodes: PmNode[] = []): string {
  let out = "";
  for (let i = 0; i < nodes.length;) {
    const [md, next] = inlineRun(nodes, i);
    out += md;
    i = next;
  }

  return out;
}

function listMd(node: PmNode, indent: string): string[] {
  const lines: string[] = [];
  (node.content ?? []).forEach((item, idx) => {
    const marker =
      node.type === "orderedList"
        ? `${idx + 1}.`
        : node.type === "taskList"
          ? `- [${item.attrs?.["checked"] ? "x" : " "}]`
          : "-";

    const [head, ...rest] = item.content ?? [];
    lines.push(`${indent}${marker} ${inlineMd(head?.content)}`);
    for (const block of rest) {
      lines.push(...listMd(block, `${indent}  `));
    }
  });

  return lines;
}

function headingMd(node: PmNode): string {
  return `${"#".repeat(Number(node.attrs?.["level"] ?? 1))} ${inlineMd(node.content)}`;
}

function quoteMd(node: PmNode): string {
  return (node.content ?? [])
    .map(blockMd)
    .join("\n\n")
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

function codeMd(node: PmNode): string {
  const lang = node.attrs?.["language"];
  const body = (node.content ?? []).map((c) => c.text ?? "").join("");
  return `\`\`\`${typeof lang === "string" ? lang : ""}\n${body}${body ? "\n" : ""}\`\`\``;
}

function tableMd(node: PmNode): string {
  const rows = (node.content ?? []).map(
    (r) => `| ${(r.content ?? []).map((c) => inlineMd(c.content?.[0]?.content)).join(" | ")} |`,
  );

  const width = node.content?.[0]?.content?.length ?? 1;
  rows.splice(1, 0, `|${" --- |".repeat(width)}`);
  return rows.join("\n");
}

const listBlockMd = (node: PmNode) => listMd(node, "").join("\n");

const BLOCK_MD = new Map<string, (node: PmNode) => string>([
  ["heading", headingMd],
  ["bulletList", listBlockMd],
  ["orderedList", listBlockMd],
  ["taskList", listBlockMd],
  ["blockquote", quoteMd],
  ["codeBlock", codeMd],
  ["horizontalRule", () => "---"],
  ["table", tableMd],
]);

// Any other block is written as its inline content.
function blockMd(node: PmNode): string {
  const render = BLOCK_MD.get(node.type);
  return render ? render(node) : inlineMd(node.content);
}

export function docToMd(doc: PmNode): string {
  return (doc.content ?? [])
    .map(blockMd)
    .filter((b, i, all) => b || all.length === 1)
    .join("\n\n");
}
