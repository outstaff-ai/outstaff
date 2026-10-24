import {
  createStaticWorkflowState,
  describeEffect,
  explainWorkflow,
  formatIssue,
  resolveWorkflow,
  WORKFLOW_EVENT_TYPES,
  type StaticWorkflowData,
  type WorkflowEvent,
  type WorkflowEventType,
} from "@outstaff/core";
import { defineCommand } from "../define.js";
import { loadTeam } from "../load.js";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what} is not valid JSON: ${(error as Error).message}`, { cause: error });
  }
}

function parseEvent(text: string): WorkflowEvent {
  const raw = parseJson(text, "The event");
  if (!isRecord(raw) || !WORKFLOW_EVENT_TYPES.includes(raw["type"] as WorkflowEventType)) {
    throw new Error(`The event needs a "type", one of: ${WORKFLOW_EVENT_TYPES.join(", ")}.`);
  }

  const actor = raw["actor"] ?? { kind: "human", id: "cli" };
  if (
    !isRecord(actor) ||
    !["human", "agent", "automation"].includes(String(actor["kind"])) ||
    typeof actor["id"] !== "string"
  ) {
    throw new Error('"actor" must be {"kind": "human" | "agent" | "automation", "id": string}.');
  }

  const subject = raw["subject"] ?? {};
  const data = raw["data"] ?? {};
  if (!isRecord(subject) || !isRecord(data)) {
    throw new Error('"subject" and "data" must be objects.');
  }

  return {
    type: raw["type"] as WorkflowEventType,
    subject,
    actor,
    data,
  } as WorkflowEvent;
}

export const explain = defineCommand<{ state?: string }>({
  name: "explain",
  group: "workflow",
  summary: "Show which workflow rules an event triggers, and why.",
  description:
    "Runs the team's workflow (its preset and rule overrides) against one event and a static snapshot of the world, and prints for every rule whether it matched, why, and what it would do. Nothing is applied. The event is JSON with a type, an optional subject, actor and data; the snapshot (--state) is JSON with tickets, prs, links and roles, and defaults to an empty world, in which most rules report that no ticket is linked. A pull request entry needs its state (open, closed or merged) and author kind; feedback on an open agent pull request is scheduled for the author whatever the ticket status, and the ticket is only moved when it is in review or blocked.",
  args: "<event-json>",
  options: [
    {
      flags: "--state <json>",
      description:
        'World snapshot as JSON: {"tickets": {"ACME-1": {"status": "review"}}, "prs": [{"ref": {"repo": {"owner": "acme", "name": "app"}, "number": 10}, "title": "Add search", "headRef": "sam/acme-1", "baseRef": "main", "draft": false, "state": "open", "author": {"login": "acme-sam[bot]", "kind": "agent", "person": "sam"}}], "links": {"10": "ACME-1"}, "roles": {}}.',
    },
  ],
  examples: [
    `ost workflow explain '{"type":"pr.comment","subject":{"pr":{"repo":{"owner":"acme","name":"app"},"number":10}},"actor":{"kind":"human","id":"dana"},"data":{"body":"please add a test"}}' --state '{"prs":[{"ref":{"repo":{"owner":"acme","name":"app"},"number":10},"title":"Add search","headRef":"sam/acme-1","baseRef":"main","draft":false,"state":"open","author":{"login":"acme-sam[bot]","kind":"agent","person":"sam"}}]}'`,
    `ost workflow explain '{"type":"ticket.assigned","subject":{"ticket":"ACME-1"},"actor":{"kind":"human","id":"dana"}}' --state '{"tickets":{"ACME-1":{"status":"ready","assignee":{"id":"sam","kind":"agent"}}}}'`,
  ],
  exitCodes: [
    "0: the event was explained (whether or not any rule matched)",
    "1: the team config could not be loaded, or the event or state is malformed",
  ],
  async run(ctx, options, args) {
    const loaded = await loadTeam(ctx, options);
    if (!loaded.ok) {
      for (const i of loaded.issues) {
        ctx.err(`error    ${formatIssue(i)}\n`);
      }

      return 1;
    }

    let event: WorkflowEvent;
    let data: StaticWorkflowData;
    try {
      event = parseEvent(args[0] ?? "");
      const state = options.state === undefined ? {} : parseJson(options.state, "--state");
      if (!isRecord(state)) {
        throw new Error("--state must be a JSON object.");
      }

      data = state as StaticWorkflowData;
    } catch (error) {
      ctx.err(`error    ${(error as Error).message}\n`);
      return 1;
    }

    const workflow = resolveWorkflow(loaded.config.workflow, loaded.config.humans);
    const explanation = explainWorkflow(
      event,
      createStaticWorkflowState(data),
      workflow.rules,
      workflow.options,
    );

    if (options.json) {
      ctx.out(`${JSON.stringify(explanation, null, 2)}\n`);
      return 0;
    }

    const out: string[] = [`Event ${explanation.event.type}`, ""];
    for (const r of explanation.rules) {
      out.push(`${r.matched ? "match  " : "no match"}  ${r.id}: ${r.reason}`);
      for (const e of r.effects) {
        out.push(`           ${describeEffect(e)}`);
      }

      for (const s of r.skipped) {
        out.push(`           skipped ${s}`);
      }
    }

    out.push("", "Effects");
    if (explanation.effects.length === 0) {
      out.push("  none");
    }

    for (const e of explanation.effects) {
      out.push(`  ${describeEffect(e)}`);
    }

    ctx.out(`${out.join("\n")}\n`);
    return 0;
  },
});
