// Markdown bullet, ordered and task lists (nested by indentation) to editor JSON.

import { paragraph, text } from "./markdown-inline.js";
import type { PmNode } from "@outstaff/integration.shared.itsaplan";

export const LIST = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const TASK = /^\[( |x|X)\]\s+(.*)$/;

const isOrdered = (marker: string) => /\d/.test(marker[0]!);

/** The list item on this line, if it belongs to the list at this indent and of this kind. */
function itemAt(line: string, indent: number, ordered: boolean): RegExpExecArray | null {
  const m = LIST.exec(line);
  return m && m[1]!.length === indent && isOrdered(m[2]!) === ordered ? m : null;
}

/** Whether a line that is not a list item continues the text of the item above it. */
const continuesItem = (line: string, indent: number) =>
  line.startsWith(" ".repeat(indent + 2)) && line.trim() !== "";

/** Reads the nested lists and continuation lines of an item into its blocks; returns the next line. */
function parseItemBody(lines: string[], start: number, indent: number, blocks: PmNode[]): number {
  let i = start;
  while (i < lines.length) {
    const n = LIST.exec(lines[i]!);
    if (n && n[1]!.length > indent) {
      const [sub, next] = parseList(lines, i, n[1]!.length);
      blocks.push(sub);
      i = next;
      continue;
    }

    if (n || !continuesItem(lines[i]!, indent)) {
      break;
    }

    const first = blocks[0]!;
    first.content = [...(first.content ?? []), text(` ${lines[i]!.trim()}`)];
    i++;
  }

  return i;
}

function listType(task: boolean, ordered: boolean): string {
  if (task) {
    return "taskList";
  }

  return ordered ? "orderedList" : "bulletList";
}

const checked = (t: RegExpExecArray | null) => t !== null && "xX".includes(t[1]!);

export function parseList(lines: string[], start: number, indent: number): [PmNode, number] {
  let i = start;
  const ordered = isOrdered(LIST.exec(lines[i]!)![2]!);
  const items: PmNode[] = [];
  // Once one item is a task, the whole list is a task list.
  let task = false;
  while (i < lines.length) {
    const m = itemAt(lines[i]!, indent, ordered);
    if (!m) {
      break;
    }

    const t = TASK.exec(m[3]!);
    task ||= t !== null;
    const blocks: PmNode[] = [paragraph(t ? t[2]! : m[3]!)];
    i = parseItemBody(lines, i + 1, indent, blocks);
    items.push(
      task
        ? { type: "taskItem", attrs: { checked: checked(t) }, content: blocks }
        : { type: "listItem", content: blocks },
    );
  }

  return [{ type: listType(task, ordered), content: items }, i];
}
