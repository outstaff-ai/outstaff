import type { ActOp, ActOutcome, ActPorts, ActTarget } from "./types.js";

const need = <T>(port: T | undefined, what: string): T => {
  if (!port) {
    throw new Error(`no ${what} is configured`);
  }

  return port;
};

async function one(
  op: ActOp,
  ports: ActPorts,
  member: (target: ActTarget) => Promise<string>,
): Promise<string> {
  switch (op.op) {
    case "move":
      await need(ports.tracker, "tracker").transition(op.ticket, op.to);
      return `moved ${op.ticket} to ${op.to}`;
    case "assign": {
      const tracker = need(ports.tracker, "tracker");
      await tracker.assign(op.ticket, op.to ? await member(op.to) : null);
      return op.to ? `assigned ${op.ticket} to ${op.to.id}` : `unassigned ${op.ticket}`;
    }

    case "comment":
      if ("ticket" in op.on) {
        await need(ports.tracker, "tracker").comment(op.on.ticket, op.body);
        return `commented on ${op.on.ticket}`;
      }

      await need(ports.knowledge, "knowledge base").comment(op.on.doc, { body: op.body });
      return `commented on doc ${op.on.doc}`;
    case "set_parent": {
      const tracker = need(ports.tracker, "tracker");
      if (!tracker.setParent) {
        throw new Error("the tracker has no parent field (tracker.parents)");
      }

      await tracker.setParent(op.ticket, op.parent);
      return `set the parent of ${op.ticket} to ${op.parent}`;
    }
  }
}

/**
 * Makes an act's changes in order through the given ports, which carry the acting identity's credentials. Stops at
 * the first change that fails; never throws.
 */
export async function applyActOps(
  ops: readonly ActOp[],
  ports: ActPorts,
  member: (target: ActTarget) => Promise<string>,
): Promise<ActOutcome> {
  const results: string[] = [];
  for (const op of ops) {
    try {
      results.push(await one(op, ports, member));
    } catch (error) {
      const what = op.op === "comment" ? "comment" : `${op.op} ${op.ticket}`;
      return { ok: false, results, error: `${what}: ${(error as Error).message}` };
    }
  }

  return { ok: true, results };
}
