import type { ItemContext } from "./prompt.js";
import type { Action, Script } from "./scripts.js";

/** The build tickets the PM splits a parent into once the human confirmed its design. */
export const BUILD_TICKETS = ["Build the gift card form", "Build the gift card preview"];

/** The PM's question on the design ticket names the parent she splits once the human confirms, linked or not. */
const SPLITS = /then I split \[?([A-Z][A-Z0-9_]*-\d+)/;

/**
 * A parent that says `confirm design: <key>` waits on the human's word on that design ticket: the PM asks them there,
 * mentioning them, and hands the parent back blocked. Undefined for any other ticket.
 */
export async function* askToConfirm(
  key: string,
  shown: string,
): AsyncGenerator<Action, string | undefined, string> {
  const design = /^confirm design: (\S+)$/m.exec(shown)?.[1];
  if (!design) {
    return undefined;
  }

  yield {
    type: "tool",
    tool: "ticket_comment",
    input: {
      key: design,
      body: `@ada-admin please confirm that revision; then I split ${key} into build tickets.`,
    },
  };

  yield { type: "tool", tool: "ticket_move", input: { key, to: "blocked" } };
  yield {
    type: "tool",
    tool: "ticket_comment",
    input: { key, body: `Blocked: waiting for ada-admin to confirm the design on ${design}.` },
  };

  yield {
    type: "tool",
    tool: "handback",
    input: {
      status: "blocked",
      message: `${key} needs ada-admin to confirm the design on ${design}.`,
    },
  };

  return `Asked ada-admin to confirm the design on ${design}.`;
}

/**
 * The human answered on the design ticket what the PM asked there: as their word, she splits the parent she held into
 * build tickets, its sub-tickets, says so on the parent, and leaves the design ticket as it is.
 */
export async function* splitOnAnswer(ctx: ItemContext, key: string): Script {
  const shown = yield { type: "tool", tool: "ticket_show", input: { key } };
  const parent = SPLITS.exec(shown)?.[1];
  if (!parent) {
    throw new Error(`${ctx.itemId}: no parent to split is named on ${key}.`);
  }

  const filed: string[] = [];
  for (const title of BUILD_TICKETS) {
    const made = yield {
      type: "tool",
      tool: "ticket_create",
      input: { title, body: `Built to the design confirmed on ${key}.`, parent, status: "backlog" },
    };

    filed.push(/^Created (\S+?)\./m.exec(made)?.[1] ?? title);
  }

  yield {
    type: "tool",
    tool: "ticket_comment",
    input: {
      key: parent,
      body: `Split into ${filed.join(" and ")}: the design on ${key} is confirmed.`,
    },
  };

  yield { type: "tool", tool: "handback", input: { status: "silent" } };
  return `Split ${parent} into ${filed.join(", ")}.`;
}
