import { describe, expect, it } from "vitest";
import { parseTeamConfig } from "../config/parse.js";
import { buildTeamJsonSchema } from "../config/json-schema.js";
import { agent, automation, ev, pr, ref, world } from "./fixtures.js";
import { presetRules } from "./presets.js";
import { mergeRules, resolveWorkflow } from "./resolve.js";
import { evaluateWorkflow, explainWorkflow } from "./evaluate.js";
import { ruleInputSchema } from "./rules.js";
import { createStatusMap } from "./status-map.js";
import { renderTemplate, TemplateError } from "./template.js";
import type { Rule } from "./rules.js";

const kanban = presetRules("kanban");
const run = (
  event: ReturnType<typeof ev>,
  state: ReturnType<typeof world>,
  rules: Rule[] = kanban,
) => evaluateWorkflow(event, state, rules);

const tk = { subject: { ticket: "ACME-1" } };

describe("kanban preset", () => {
  it("pr opened moves the ticket to review, unless draft or already done", () => {
    expect(run(ev("pr.opened", { actor: agent }), world({ status: "active" }))).toEqual([
      { type: "move", ticket: "ACME-1", to: "review" },
    ]);

    expect(
      run(ev("pr.opened"), world({ status: "active", prs: [pr(10, { draft: true })] })),
    ).toEqual([]);

    expect(run(ev("pr.opened"), world({ status: "done" }))).toEqual([]);
  });

  it("pr opened without a linked ticket does nothing", () => {
    expect(run(ev("pr.opened", { subject: { pr: ref(99) } }), world())).toEqual([]);
  });

  it("merged moves to done", () => {
    expect(run(ev("pr.merged"), world({ status: "review" }))).toEqual([
      { type: "move", ticket: "ACME-1", to: "done" },
    ]);

    expect(run(ev("pr.merged"), world({ status: "done" }))).toEqual([]);
  });

  it("closed unmerged moves to ready", () => {
    expect(run(ev("pr.closed"), world({ status: "review" }))).toEqual([
      { type: "move", ticket: "ACME-1", to: "ready" },
    ]);

    expect(run(ev("pr.closed"), world({ status: "done" }))).toEqual([]);
  });

  it.each(["pr.review_submitted", "pr.comment"] as const)(
    "human %s sends review work back to the author",
    (type) => {
      expect(
        run(ev(type, { data: { state: "changes_requested" } }), world({ status: "review" })),
      ).toEqual([
        { type: "assign", ticket: "ACME-1", to: { kind: "agent", id: "ada" } },
        { type: "move", ticket: "ACME-1", to: "active" },
        {
          type: "schedule",
          person: "ada",
          kind: "review_feedback",
          priority: "high",
          ticket: "ACME-1",
          pr: ref(10),
        },
      ]);
    },
  );

  it("feedback also applies to blocked tickets", () => {
    expect(run(ev("pr.comment"), world({ status: "blocked" }))).toHaveLength(3);
  });

  it("ignores approvals, agent feedback, human authors and tickets not in review", () => {
    expect(run(ev("pr.review_submitted", { data: { state: "approved" } }), world())).toEqual([]);
    expect(run(ev("pr.comment", { actor: agent }), world())).toEqual([]);
    expect(run(ev("pr.comment"), world({ status: "active" }))).toEqual([]);
    expect(
      run(
        ev("pr.comment"),
        world({ prs: [pr(10, { author: { login: "grace", kind: "human" } })] }),
      ),
    ).toEqual([]);
  });

  it("conflict goes back to the author with recipe and schedule", () => {
    const out = run(ev("pr.conflicted", { actor: automation }), world());
    expect(out.map((e) => e.type)).toEqual(["assign", "move", "comment", "schedule"]);
    const comment = out[2]!;
    expect(comment).toMatchObject({
      type: "comment",
      on: { ticket: "ACME-1" },
      template: "rebase_conflict",
    });

    if (comment.type !== "comment") {
      throw new Error();
    }

    expect(comment.body).toContain("git rebase origin/main");
    expect(comment.body).toContain("1. #10 Change 10");
    expect(out[3]).toMatchObject({
      type: "schedule",
      person: "ada",
      kind: "conflict",
      priority: "high",
    });
  });

  it("stacked conflict comment lists the stack bottom first", () => {
    const state = world({
      prs: [
        pr(12, { headRef: "feat-12", baseRef: "feat-11" }),
        pr(10),
        pr(11, { headRef: "feat-11", baseRef: "feat-10" }),
        pr(20, { headRef: "other", baseRef: "main" }),
      ],
    });

    const out = run(ev("pr.conflicted", { actor: automation }), state);
    const comment = out.find((e) => e.type === "comment");
    if (comment?.type !== "comment") {
      throw new Error();
    }

    const lines = comment.body.split("\n").filter((l) => /^\d+\. #/.test(l));
    expect(lines.map((l) => l.split(" ")[1])).toEqual(["#10", "#11", "#12"]);
    expect(comment.body).toContain("(3)");
    expect(comment.body).not.toContain("#20");
  });

  it("stack walk survives cyclic data", () => {
    const state = world({
      prs: [pr(10, { headRef: "a", baseRef: "b" }), pr(11, { headRef: "b", baseRef: "a" })],
    });

    expect(() => run(ev("pr.conflicted"), state)).not.toThrow();
  });

  it("a human moving a ticket to active returns it to the last worker", () => {
    const state = world({ status: "active", ticket: { assignee: { id: "grace", kind: "human" } } });
    expect(
      run(ev("ticket.moved", { ...tk, data: { from: "ready", to: "active" } }), state),
    ).toEqual([
      { type: "assign", ticket: "ACME-1", to: { kind: "agent", id: "ada" } },
      { type: "schedule", person: "ada", kind: "assigned", priority: "normal", ticket: "ACME-1" },
    ]);
  });

  it("take-back is skipped with the needs-human label, other moves, or an agent assignee", () => {
    const base = { ...tk, data: { to: "active" } };
    const humanActor = { id: "grace", kind: "human" as const };
    expect(
      run(
        ev("ticket.moved", base),
        world({ status: "active", ticket: { assignee: humanActor, labels: ["needs-human"] } }),
      ),
    ).toEqual([]);

    expect(
      run(
        ev("ticket.moved", { ...tk, data: { to: "review" } }),
        world({ status: "review", ticket: { assignee: humanActor } }),
      ),
    ).toEqual([]);

    expect(
      run(
        ev("ticket.moved", base),
        world({ status: "active", ticket: { assignee: { id: "ada", kind: "agent" } } }),
      ),
    ).toEqual([]);
  });

  it("take-back honours a custom label name", () => {
    const state = world({
      status: "active",
      ticket: { assignee: { id: "grace", kind: "human" }, labels: ["hold"] },
    });

    const e = ev("ticket.moved", { ...tk, data: { to: "active" } });
    expect(evaluateWorkflow(e, state, kanban, { needsHumanLabel: "hold" })).toEqual([]);
    expect(evaluateWorkflow(e, state, kanban)).toHaveLength(2);
  });

  it("take-back with no previous worker only skips the unresolvable actions", () => {
    const state = world({ status: "active", ticket: { assignee: { id: "grace", kind: "human" } } });
    const noWorker = {
      ...state,
      lastWorker: () => undefined,
    };

    const x = explainWorkflow(
      ev("ticket.moved", { ...tk, data: { to: "active" } }),
      noWorker,
      kanban,
    );

    expect(x.effects).toEqual([]);
    expect(x.rules.find((r) => r.id === "active-human-takeback")?.skipped).toHaveLength(2);
  });

  it("hand-back moves to review and assigns the requester", () => {
    expect(
      run(ev("agent.handed_back", { ...tk, actor: agent }), world({ status: "active" })),
    ).toEqual([
      { type: "move", ticket: "ACME-1", to: "review" },
      { type: "assign", ticket: "ACME-1", to: { kind: "human", id: "grace" } },
    ]);
  });

  it("assignment to an agent schedules that agent, but not for our own assignments or finished tickets", () => {
    const a = { id: "ada", kind: "agent" as const };
    const e = ev("ticket.assigned", { ...tk });
    expect(run(e, world({ status: "ready", ticket: { assignee: a } }))).toEqual([
      { type: "schedule", person: "ada", kind: "assigned", priority: "normal", ticket: "ACME-1" },
    ]);

    expect(run({ ...e, actor: automation }, world({ ticket: { assignee: a } }))).toEqual([]);
    expect(run(e, world({ status: "done", ticket: { assignee: a } }))).toEqual([]);
    expect(run(e, world({ ticket: { assignee: { id: "grace", kind: "human" } } }))).toEqual([]);
  });
});

describe("scrum and minimal presets", () => {
  const a = { id: "ada", kind: "agent" as const };
  const e = ev("ticket.assigned", { ...tk });

  it("scrum does not start uncommitted backlog work", () => {
    const scrum = presetRules("scrum");
    expect(run(e, world({ status: "backlog", ticket: { assignee: a } }), scrum)).toEqual([]);
    expect(run(e, world({ status: "ready", ticket: { assignee: a } }), scrum)).toHaveLength(1);
    expect(run(e, world({ status: "backlog", ticket: { assignee: a } }), kanban)).toHaveLength(1);
  });

  it("scrum keeps the other kanban rules", () => {
    const scrum = presetRules("scrum");
    expect(scrum.map((r) => r.id)).toEqual(kanban.map((r) => r.id));
    expect(run(ev("pr.merged"), world(), scrum)).toEqual([
      { type: "move", ticket: "ACME-1", to: "done" },
    ]);
  });

  it("minimal never moves a ticket", () => {
    const minimal = presetRules("minimal");
    for (const t of [
      "pr.opened",
      "pr.merged",
      "pr.closed",
      "pr.conflicted",
      "agent.handed_back",
    ] as const) {
      expect(run(ev(t, { ...tk }), world(), minimal)).toEqual([]);
    }

    expect(run(ev("pr.comment"), world(), minimal)).toEqual([
      { type: "assign", ticket: "ACME-1", to: { kind: "agent", id: "ada" } },
      {
        type: "schedule",
        person: "ada",
        kind: "review_feedback",
        priority: "high",
        ticket: "ACME-1",
        pr: ref(10),
      },
    ]);

    expect(run(e, world({ ticket: { assignee: a } }), minimal)).toHaveLength(1);
  });

  it("every preset rule is valid against the rule schema", () => {
    for (const p of ["kanban", "scrum", "minimal"] as const) {
      for (const r of presetRules(p)) {
        expect(ruleInputSchema.safeParse(r).success, `${p}/${r.id}`).toBe(true);
      }
    }
  });
});

describe("overrides", () => {
  it("replaces in place by id, appends new ids, and removes disabled ones", () => {
    const custom: Rule = { id: "pr-merged-done", on: "pr.merged", do: [{ move: "review" }] };
    const extra: Rule = { id: "mine", on: "pr.closed", do: [{ move: "canceled" }] };
    const merged = mergeRules(kanban, [custom, extra, { id: "pr-opened-review", disabled: true }]);
    expect(merged.map((r) => r.id)).toEqual([
      ...kanban.map((r) => r.id).filter((i) => i !== "pr-opened-review"),
      "mine",
    ]);

    expect(merged.find((r) => r.id === "pr-merged-done")).toBe(custom);
    expect(merged.indexOf(custom)).toBe(kanban.findIndex((r) => r.id === "pr-merged-done") - 1);
    expect(run(ev("pr.opened", { actor: agent }), world({ status: "active" }), merged)).toEqual([]);
    expect(run(ev("pr.merged"), world({ status: "active" }), merged)).toEqual([
      { type: "move", ticket: "ACME-1", to: "review" },
    ]);
  });

  it("does not mutate the preset", () => {
    mergeRules(presetRules("kanban"), [{ id: "pr-opened-review", disabled: true }]);
    expect(presetRules("kanban").some((r) => r.id === "pr-opened-review")).toBe(true);
  });

  it("resolves from team config, including custom templates and label", () => {
    const base = {
      version: 1,
      team: { name: "acme" },
      catalog: { version: "1.0.0" },
      repos: [{ name: "app", url: "github.com/acme/app", kind: "primary" }],
      people: [{ handle: "ada", name: "Ada", role: "r" }],
      integrations: { chat: { adapter: "a" }, vcs: { adapter: "b" }, runtime: { adapter: "c" } },
    };

    const r = parseTeamConfig({
      ...base,
      workflow: {
        preset: "minimal",
        statuses: { review: "In Review" },
        needs_human_label: "hold",
        templates: { ping: "{{ticket}} needs {{actor.id}}" },
        rules: [
          {
            id: "ping-requester",
            on: "pr.opened",
            do: [{ notify: { to: "requester", template: "ping" } }],
          },
        ],
      },
    });

    if (!r.ok) {
      throw new Error(JSON.stringify(r.issues));
    }

    const w = resolveWorkflow(r.config.workflow);
    expect(w.rules.map((x) => x.id)).toEqual([
      "human-feedback-back-to-author",
      "assigned-agent-scheduled",
      "ping-requester",
    ]);

    expect(w.statuses.toTracker("review")).toBe("In Review");
    expect(evaluateWorkflow(ev("pr.opened"), world(), w.rules, w.options)).toEqual([
      {
        type: "notify",
        to: { kind: "human", id: "grace" },
        template: "ping",
        body: "ACME-1 needs grace",
        ticket: "ACME-1",
        pr: ref(10),
      },
    ]);

    expect(resolveWorkflow(undefined).rules).toHaveLength(kanban.length);
  });
});

describe("config validation", () => {
  const base = {
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    repos: [{ name: "app", url: "github.com/acme/app", kind: "primary" }],
    people: [{ handle: "ada", name: "Ada", role: "r" }],
    integrations: { chat: { adapter: "a" }, vcs: { adapter: "b" }, runtime: { adapter: "c" } },
  };

  const codes = (workflow: unknown) => {
    const r = parseTeamConfig({ ...base, workflow });
    return r.ok ? [] : r.issues.map((i) => i.code);
  };

  const rule = { id: "x", on: "pr.opened", do: [{ move: "review" }] };

  it("accepts good rules and rejects unknown keys and values", () => {
    expect(codes({ rules: [rule] })).toEqual([]);
    expect(codes({ rules: [{ ...rule, when: "x" }] }).length).toBeGreaterThan(0);
    expect(codes({ rules: [{ ...rule, on: "pr.exploded" }] }).length).toBeGreaterThan(0);
    expect(codes({ rules: [{ ...rule, do: [{ move: "wip" }] }] }).length).toBeGreaterThan(0);
    expect(codes({ rules: [{ ...rule, do: [{ assign: "nobody" }] }] }).length).toBeGreaterThan(0);
    expect(
      codes({ rules: [{ ...rule, if: { actor_kind: "human", pr_draft: true } }] }).length,
    ).toBeGreaterThan(0);
  });

  it("accepts nested conditions and applies the schedule priority default", () => {
    const r = parseTeamConfig({
      ...base,
      workflow: {
        rules: [
          {
            ...rule,
            if: {
              any: [
                { not: { actor_kind: "agent" } },
                { all: [{ has_label: "x" }, { pr_draft: false }] },
              ],
            },
            do: [{ schedule: { person: "role:reviewer", kind: "review" } }],
          },
        ],
      },
    });

    if (!r.ok) {
      throw new Error(JSON.stringify(r.issues));
    }

    expect(JSON.stringify(r.config.workflow?.rules)).toContain('"priority":"normal"');
  });

  it("reports duplicate ids, unknown disables, unknown templates and placeholders, duplicate status names", () => {
    expect(codes({ rules: [rule, rule] })).toContain("workflow.duplicate_rule_id");
    expect(codes({ rules: [{ id: "nope", disabled: true }] })).toContain("workflow.unknown_rule");
    expect(codes({ rules: [{ ...rule, do: [{ comment: "missing" }] }] })).toContain(
      "workflow.unknown_template",
    );

    expect(codes({ templates: { t: "{{bogus}}" } })).toContain("workflow.unknown_placeholder");
    expect(codes({ templates: { t: "{{ticket" } })).toContain("workflow.unknown_placeholder");
    expect(codes({ statuses: { review: "Doing", active: "doing" } })).toContain(
      "workflow.duplicate_status_name",
    );
  });

  it("publishes the rule shape in the JSON Schema", () => {
    const json = JSON.stringify(buildTeamJsonSchema());
    expect(json).toContain("ticket_status");
    expect(json).toContain("needs_human_label");
  });
});

describe("explain", () => {
  it("says why each rule did or did not match", () => {
    const x = explainWorkflow(ev("pr.comment"), world({ status: "active" }), kanban);
    const by = Object.fromEntries(x.rules.map((r) => [r.id, r]));
    expect(by["pr-merged-done"]).toMatchObject({
      matched: false,
      reason: "listens to pr.merged, not pr.comment",
    });

    expect(by["human-feedback-back-to-author"]).toMatchObject({ matched: false });
    expect(by["human-feedback-back-to-author"]?.reason).toBe(
      "ticket status active in [review, blocked]",
    );

    expect(x.effects).toEqual([]);
  });

  it("lists effects and skipped actions of matching rules", () => {
    const x = explainWorkflow(ev("pr.merged"), world(), kanban);
    expect(x.rules.find((r) => r.id === "pr-merged-done")).toMatchObject({
      matched: true,
      effects: [{ type: "move", ticket: "ACME-1", to: "done" }],
      skipped: [],
    });

    const none = explainWorkflow(ev("pr.merged", { subject: { pr: ref(99) } }), world(), kanban);
    expect(none.rules.find((r) => r.id === "pr-merged-done")?.reason).toContain("no linked ticket");
  });

  it("reports a move that is already in effect", () => {
    const rules: Rule[] = [{ id: "r", on: "pr.merged", do: [{ move: "review" }] }];
    const x = explainWorkflow(ev("pr.merged"), world(), rules);
    expect(x.rules[0]?.skipped).toEqual(["move: ticket is already review"]);
  });
});

describe("determinism and dedupe", () => {
  it("returns identical output for identical input and dedupes identical effects", () => {
    const rules: Rule[] = [
      { id: "a", on: "pr.merged", do: [{ move: "done" }, { move: "done" }] },
      { id: "b", on: "pr.merged", do: [{ move: "done" }, { assign: "none" }] },
    ];

    const state = world();
    const first = evaluateWorkflow(ev("pr.merged"), state, rules);
    expect(first).toEqual([
      { type: "move", ticket: "ACME-1", to: "done" },
      { type: "assign", ticket: "ACME-1", to: null },
    ]);

    for (let i = 0; i < 5; i++) {
      expect(evaluateWorkflow(ev("pr.merged"), state, rules)).toEqual(first);
    }
  });

  it("supports role targets, human targets and pr-targeted comments", () => {
    const rules: Rule[] = [
      {
        id: "r",
        on: "pr.opened",
        do: [
          { assign: "role:reviewer" },
          { assign: "human:grace" },
          { schedule: { person: "role:reviewer", kind: "review", priority: "low" } },
          { comment: { template: "rebase_conflict", on: "pr" } },
          { notify: { to: "channel:dev", template: "rebase_conflict" } },
        ],
      },
    ];

    const out = evaluateWorkflow(ev("pr.opened"), world(), rules);
    expect(out.map((e) => e.type)).toEqual(["assign", "assign", "schedule", "comment", "notify"]);
    expect(out[0]).toMatchObject({ to: { kind: "agent", id: "rex" } });
    expect(out[3]).toMatchObject({ on: { pr: ref(10) } });
    expect(out[4]).toMatchObject({ to: { kind: "channel", id: "dev" } });
  });

  it("matches multiple event types", () => {
    const rules: Rule[] = [{ id: "r", on: ["pr.opened", "pr.closed"], do: [{ move: "canceled" }] }];
    expect(evaluateWorkflow(ev("pr.closed"), world(), rules)).toHaveLength(1);
    expect(evaluateWorkflow(ev("pr.merged"), world(), rules)).toHaveLength(0);
  });
});

describe("status map and templates", () => {
  it("defaults to Title Case and maps both ways case-insensitively", () => {
    const m = createStatusMap({ review: "In Review" });
    expect(m.toTracker("backlog")).toBe("Backlog");
    expect(m.toTracker("review")).toBe("In Review");
    expect(m.toCanonical("in review")).toBe("review");
    expect(m.toCanonical("Canceled")).toBe("canceled");
    expect(m.toCanonical("Review")).toBeUndefined();
    expect(m.toCanonical("Nope")).toBeUndefined();
  });

  it("renders strictly", () => {
    expect(renderTemplate("a {{ x }} b {{y.z}}", { x: "1", "y.z": "2" })).toBe("a 1 b 2");
    expect(() => renderTemplate("{{missing}}", {})).toThrow(TemplateError);
    expect(() => renderTemplate("{{oops", {})).toThrow(TemplateError);
    expect(() => renderTemplate("}}", {})).toThrow(TemplateError);
  });

  it("skips a comment whose custom template uses an unknown variable instead of throwing", () => {
    const rules: Rule[] = [{ id: "r", on: "pr.opened", do: [{ comment: "bad" }] }];
    const x = explainWorkflow(ev("pr.opened"), world(), rules, { templates: { bad: "{{nope}}" } });
    expect(x.effects).toEqual([]);
    expect(x.rules[0]?.skipped[0]).toContain("Unknown template variable");
  });
});
