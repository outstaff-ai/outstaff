import {
  createStaticWorkflowState,
  describeEffect,
  explainWorkflow,
  formatIssue,
  resolveWorkflow,
  switchOfRule,
  WORKFLOW_EVENT_TYPES,
  type StaticWorkflowData,
  type TeamConfig,
  type WorkflowEvent,
  type WorkflowEventType,
} from "@outstaff/core";
import { defineCommand } from "#/define.js";
import { loadTeam } from "#/load.js";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what} is not valid JSON: ${(error as Error).message}`, { cause: error });
  }
}

const ACTOR_KINDS = ["human", "agent", "automation"];

const isEventType = (v: unknown): v is WorkflowEventType =>
  WORKFLOW_EVENT_TYPES.includes(v as WorkflowEventType);

const isActor = (v: unknown): v is Record<string, unknown> =>
  isRecord(v) && ACTOR_KINDS.includes(String(v["kind"])) && typeof v["id"] === "string";

/** The event's actor; a human at the CLI when it has none. */
function parseActor(raw: Record<string, unknown>): Record<string, unknown> {
  const actor = raw["actor"] ?? { kind: "human", id: "cli" };
  if (!isActor(actor)) {
    throw new Error('"actor" must be {"kind": "human" | "agent" | "automation", "id": string}.');
  }

  return actor;
}

function parseEvent(text: string): WorkflowEvent {
  const raw = parseJson(text, "The event");
  if (!isRecord(raw) || !isEventType(raw["type"])) {
    throw new Error(`The event needs a "type", one of: ${WORKFLOW_EVENT_TYPES.join(", ")}.`);
  }

  const actor = parseActor(raw);
  const subject = raw["subject"] ?? {};
  const data = raw["data"] ?? {};
  if (!isRecord(subject) || !isRecord(data)) {
    throw new Error('"subject" and "data" must be objects.');
  }

  return {
    type: raw["type"],
    subject,
    actor,
    data,
  } as WorkflowEvent;
}

/** The --state snapshot; an empty world when it is not given. */
function parseState(text: string | undefined): StaticWorkflowData {
  const state = text === undefined ? {} : parseJson(text, "--state");
  if (!isRecord(state)) {
    throw new Error("--state must be a JSON object.");
  }

  return state as StaticWorkflowData;
}

const switchOf = (id: string) => {
  const sw = switchOfRule(id);
  return sw ? `policies.${sw.path}` : undefined;
};

type Explained = {
  explanation: ReturnType<typeof explainWorkflow>;
  switchedOff: { rule: string; switch: string; effect: string }[];
};

type RuleResult = Explained["explanation"]["rules"][number];

/** Runs the team's workflow against the event and snapshot, and lists the rules a policy switched off for it. */
function explainEvent(
  config: TeamConfig,
  event: WorkflowEvent,
  data: StaticWorkflowData,
): Explained {
  const workflow = resolveWorkflow(config.workflow, config.humans, config.policies);
  const explanation = explainWorkflow(
    event,
    createStaticWorkflowState(data),
    workflow.rules,
    workflow.options,
  );

  const switchedOff = workflow.switched
    .filter((s) => [s.on].flat().includes(event.type))
    .map((s) => ({
      rule: s.rule,
      switch: `policies.${s.switch}`,
      effect: s.effect,
    }));

  return { explanation, switchedOff };
}

function explainedJson({ explanation, switchedOff }: Explained): string {
  return `${JSON.stringify(
    {
      ...explanation,
      rules: explanation.rules.map((r) => {
        const sw = switchOf(r.id);
        return sw ? { ...r, switch: sw } : r;
      }),
      switchedOff,
    },
    null,
    2,
  )}\n`;
}

/** One rule: whether it matched and why, its switch, and what it would do or skipped. */
function ruleLines(r: RuleResult): string[] {
  const sw = switchOf(r.id);
  return [
    `${r.matched ? "match  " : "no match"}  ${r.id}: ${r.reason}`,
    ...(sw ? [`           switch ${sw}`] : []),
    ...r.effects.map((e) => `           ${describeEffect(e)}`),
    ...r.skipped.map((s) => `           skipped ${s}`),
  ];
}

function explainedText({ explanation, switchedOff }: Explained): string {
  const effects = explanation.effects.map((e) => `  ${describeEffect(e)}`);
  return [
    `Event ${explanation.event.type}`,
    "",
    ...explanation.rules.flatMap(ruleLines),
    ...switchedOff.map(
      (s) =>
        `${s.effect === "removed" ? "off     " : "edited  "}  ${s.rule}: ${s.effect} by ${s.switch}`,
    ),
    "",
    "Effects",
    ...(effects.length === 0 ? ["  none"] : effects),
  ].join("\n");
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
      data = parseState(options.state);
    } catch (error) {
      ctx.err(`error    ${(error as Error).message}\n`);
      return 1;
    }

    const explained = explainEvent(loaded.config, event, data);
    ctx.out(options.json ? explainedJson(explained) : `${explainedText(explained)}\n`);
    return 0;
  },
});
