import type { ActOp, ActOutcome, ActPorts, ActTarget } from "./types.js";

const need = <T>(port: T | undefined, what: string): T => {
  if (!port) {
    throw new Error(`no ${what} is configured`);
  }

  return port;
};

type Member = (target: ActTarget) => Promise<string>;
type Make<K extends ActOp["op"]> = (
  op: Extract<ActOp, { op: K }>,
  ports: ActPorts,
  member: Member,
) => Promise<string>;

const move: Make<"move"> = async (op, ports) => {
  await need(ports.tracker, "tracker").transition(op.ticket, op.to);
  return `moved ${op.ticket} to ${op.to}`;
};

const assign: Make<"assign"> = async (op, ports, member) => {
  const tracker = need(ports.tracker, "tracker");
  if (!op.to) {
    await tracker.assign(op.ticket, null);
    return `unassigned ${op.ticket}`;
  }

  await tracker.assign(op.ticket, await member(op.to));
  return `assigned ${op.ticket} to ${op.to.id}`;
};

const comment: Make<"comment"> = async (op, ports) => {
  if ("ticket" in op.on) {
    await need(ports.tracker, "tracker").comment(op.on.ticket, op.body);
    return `commented on ${op.on.ticket}`;
  }

  await need(ports.knowledge, "knowledge base").comment(op.on.doc, { body: op.body });
  return `commented on doc ${op.on.doc}`;
};

const setParent: Make<"set_parent"> = async (op, ports) => {
  const tracker = need(ports.tracker, "tracker");
  if (!tracker.setParent) {
    throw new Error("the tracker has no parent field (tracker.parents)");
  }

  await tracker.setParent(op.ticket, op.parent);
  return `set the parent of ${op.ticket} to ${op.parent}`;
};

const linkPr: Make<"link_pr"> = async (op, ports) => {
  const tracker = need(ports.tracker, "tracker");
  if (!tracker.linkPullRequest) {
    throw new Error("the tracker cannot link pull requests (tracker.development)");
  }

  const { repo, number } = op.pr;
  const pr = `${repo.owner}/${repo.name}#${number}`;
  switch (await tracker.linkPullRequest(op.ticket, op.pr)) {
    case "linked":
      return `linked ${pr} on ${op.ticket}`;
    case "already_linked":
      return `${pr} was already linked on ${op.ticket}`;
    case "not_connected":
      throw new Error(
        `${repo.owner}/${repo.name} is not connected to the tracker; connect the repository in the tracker's integrations`,
      );
  }
};

function one(op: ActOp, ports: ActPorts, member: Member): Promise<string> {
  switch (op.op) {
    case "move":
      return move(op, ports, member);
    case "assign":
      return assign(op, ports, member);
    case "comment":
      return comment(op, ports, member);
    case "set_parent":
      return setParent(op, ports, member);
    case "link_pr":
      return linkPr(op, ports, member);
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
