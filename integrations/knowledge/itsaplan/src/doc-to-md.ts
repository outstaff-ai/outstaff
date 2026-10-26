import type { Mark, PmNode } from "./types.js";

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

// Marks are listed outermost first; neighbours that share their outer mark are wrapped together.
function inlineMd(nodes: PmNode[] = []): string {
  let out = "";
  for (let i = 0; i < nodes.length;) {
    const node = nodes[i]!;
    if (node.type === "hardBreak") {
      out += "  \n";
      i++;
      continue;
    }

    const outer = node.marks?.[0];
    if (!outer) {
      out += node.text ?? "";
      i++;
      continue;
    }

    const run: PmNode[] = [];
    while (i < nodes.length && sameMark(nodes[i]!.marks?.[0], outer)) {
      const n = nodes[i]!;
      run.push({ ...n, marks: n.marks!.slice(1) });
      i++;
    }

    out += wrapMark(outer, inlineMd(run));
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

function blockMd(node: PmNode): string {
  switch (node.type) {
    case "heading":
      return `${"#".repeat(Number(node.attrs?.["level"] ?? 1))} ${inlineMd(node.content)}`;
    case "bulletList":
    case "orderedList":
    case "taskList":
      return listMd(node, "").join("\n");
    case "blockquote":
      return (node.content ?? [])
        .map(blockMd)
        .join("\n\n")
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    case "codeBlock": {
      const lang = node.attrs?.["language"];
      const body = (node.content ?? []).map((c) => c.text ?? "").join("");
      return `\`\`\`${typeof lang === "string" ? lang : ""}\n${body}${body ? "\n" : ""}\`\`\``;
    }

    case "horizontalRule":
      return "---";
    case "table": {
      const rows = (node.content ?? []).map(
        (r) => `| ${(r.content ?? []).map((c) => inlineMd(c.content?.[0]?.content)).join(" | ")} |`,
      );

      const width = node.content?.[0]?.content?.length ?? 1;
      rows.splice(1, 0, `|${" --- |".repeat(width)}`);
      return rows.join("\n");
    }

    default:
      return inlineMd(node.content);
  }
}

export function docToMd(doc: PmNode): string {
  return (doc.content ?? [])
    .map(blockMd)
    .filter((b, i, all) => b || all.length === 1)
    .join("\n\n");
}
