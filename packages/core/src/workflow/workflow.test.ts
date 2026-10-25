import { describe, expect, it } from "vitest";
import { parseTeamConfig } from "../config/parse.js";
import { buildTeamJsonSchema } from "../config/json-schema.js";
import { agent, automation, ev, pr, ref, world } from "./fixtures.js";
import { presetRules } from "./presets.js";
import { createStaticWorkflowState } from "./state.js";
import { mergeRules, resolveWorkflow } from "./resolve.js";
import { evaluateWorkflow, explainWorkflow } from "./evaluate.js";
import { ruleInputSchema } from "./rules.js";
import { createStatusMap } from "./status-map.js";
import { renderTemplate, TemplateError } from "./template.js";
import type { Rule } from "./rules.js";

const kanban = presetRules("kanban");

const baseConfig = () => ({
  version: 1,
  team: { name: "acme" },
  humans: [{ name: "Ada", identities: { tracker: "Ada" } }],
  catalog: { version: "1.0.0" },
  repos: [{ name: "app", url: "github.com/acme/app", kind: "primary" }],
  people: [{ handle: "ada", name: "Ada", role: "r" }],
  integrations: { chat: { adapter: "a" }, vcs: { adapter: "b" }, runtime: { adapter: "c" } },
});

const feedbackSchedule = (ticket?: string) => ({
  type: "schedule",
  person: "ada",
  kind: "review_feedback",
  priority: "high",
  ...(ticket ? { ticket } : {}),
  pr: ref(10),
});

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
    "human %s on a ticket in review sends the work back to the author",
    (type) => {
      expect(
        run(ev(type, { data: { state: "changes_requested" } }), world({ status: "review" })),
      ).toEqual([
        feedbackSchedule("ACME-1"),
        { type: "assign", ticket: "ACME-1", to: { kind: "agent", id: "ada" } },
        { type: "move", ticket: "ACME-1", to: "active" },
      ]);
    },
  );

  it("feedback also reactivates blocked tickets", () => {
    expect(run(ev("pr.comment"), world({ status: "blocked" }))).toHaveLength(3);
  });

  it.each(["backlog", "ready", "active", "done", "canceled"] as const)(
    "feedback reaches the author but leaves a %s ticket alone",
    (status) => {
      expect(run(ev("pr.comment"), world({ status }))).toEqual([feedbackSchedule("ACME-1")]);
      expect(
        run(
          ev("pr.review_submitted", { data: { state: "commented", body: "hm" } }),
          world({ status }),
        ),
      ).toEqual([feedbackSchedule("ACME-1")]);
    },
  );

  it("feedback reaches the author when the pull request has no ticket", () => {
    const noTicket = createStaticWorkflowState({ prs: [pr(10)] });
    expect(run(ev("pr.comment"), noTicket)).toEqual([feedbackSchedule()]);
    expect(
      run(ev("pr.review_submitted", { data: { state: "changes_requested" } }), noTicket),
    ).toEqual([feedbackSchedule()]);
  });

  it("an approval with a body is feedback, one without is not", () => {
    const approved = (body?: string) =>
      ev("pr.review_submitted", {
        data: { state: "approved", ...(body === undefined ? {} : { body }) },
      });

    expect(run(approved("Ship it, but rename the flag."), world({ status: "ready" }))).toEqual([
      feedbackSchedule("ACME-1"),
    ]);

    expect(run(approved(""), world())).toEqual([]);
    expect(run(approved("  \n"), world())).toEqual([]);
    expect(run(approved(), world())).toEqual([]);
  });

  it("an inline comment left with an approval still reaches the author", () => {
    expect(
      run(ev("pr.comment", { data: { kind: "review_comment", body: "nit" } }), world()),
    ).toEqual(expect.arrayContaining([feedbackSchedule("ACME-1")]));
  });

  it("ignores agent feedback, closed pull requests and human-authored ones", () => {
    expect(run(ev("pr.comment", { actor: agent }), world())).toEqual([]);
    expect(run(ev("pr.comment"), world({ prs: [pr(10, { state: "closed" })] }))).toEqual([]);

    expect(
      run(
        ev("pr.comment"),
        world({ prs: [pr(10, { author: { login: "grace", kind: "human" } })] }),
      ),
    ).toEqual([]);

    expect(
      run(
        ev("pr.comment"),
        world({ prs: [pr(10, { author: { login: "dependabot[bot]", kind: "bot" } })] }),
      ),
    ).toEqual([]);
  });

  describe("merged-feedback-follow-up", () => {
    const merged = (status: "done" | "review" = "done") =>
      world({ status, prs: [pr(10, { state: "merged" })] });

    const followUp = (ticket?: string) => ({
      type: "schedule",
      person: "ada",
      kind: "merged_feedback",
      priority: "high",
      ...(ticket ? { ticket } : {}),
      pr: ref(10),
    });

    it.each(["kanban", "scrum", "minimal"] as const)(
      "%s: feedback on a merged agent pull request schedules merged_feedback and touches nothing else",
      (preset) => {
        const rules = presetRules(preset);
        for (const type of ["pr.review_submitted", "pr.comment"] as const) {
          expect(
            run(ev(type, { data: { state: "commented", body: "hm" } }), merged(), rules),
          ).toEqual([followUp("ACME-1")]);
        }

        // The ticket is not reopened, whatever its status.
        expect(run(ev("pr.comment"), merged("review"), rules)).toEqual([followUp("ACME-1")]);
      },
    );

    it("a review that asks for changes counts; a bare approval does not", () => {
      expect(
        run(ev("pr.review_submitted", { data: { state: "changes_requested" } }), merged()),
      ).toEqual([followUp("ACME-1")]);

      const approved = (body?: string) =>
        ev("pr.review_submitted", {
          data: { state: "approved", ...(body === undefined ? {} : { body }) },
        });

      expect(run(approved("Thanks, but the flag name is wrong."), merged())).toEqual([
        followUp("ACME-1"),
      ]);

      expect(run(approved(""), merged())).toEqual([]);
      expect(run(approved("  \n"), merged())).toEqual([]);
      expect(run(approved(), merged())).toEqual([]);
    });

    it("an agent or automation commenter, a human-authored pull request or a closed one does nothing", () => {
      expect(run(ev("pr.comment", { actor: agent }), merged())).toEqual([]);
      expect(run(ev("pr.comment", { actor: automation }), merged())).toEqual([]);
      expect(
        run(
          ev("pr.comment"),
          world({
            prs: [pr(10, { state: "merged", author: { login: "grace", kind: "human" } })],
          }),
        ),
      ).toEqual([]);

      expect(run(ev("pr.comment"), world({ prs: [pr(10, { state: "closed" })] }))).toEqual([]);
    });

    it("works without a linked ticket", () => {
      expect(
        run(ev("pr.comment"), createStaticWorkflowState({ prs: [pr(10, { state: "merged" })] })),
      ).toEqual([followUp()]);
    });
  });

  it("the scrum preset behaves the same", () => {
    const scrum = presetRules("scrum");
    expect(run(ev("pr.comment"), world({ status: "review" }), scrum)).toHaveLength(3);
    expect(run(ev("pr.comment"), world({ status: "backlog" }), scrum)).toEqual([
      feedbackSchedule("ACME-1"),
    ]);

    expect(run(ev("pr.comment"), createStaticWorkflowState({ prs: [pr(10)] }), scrum)).toEqual([
      feedbackSchedule(),
    ]);
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

  it("a done hand-back moves to review and assigns the requester", () => {
    expect(
      run(
        ev("agent.handed_back", { ...tk, actor: agent, data: { status: "done" } }),
        world({ status: "active" }),
      ),
    ).toEqual([
      { type: "move", ticket: "ACME-1", to: "review" },
      { type: "assign", ticket: "ACME-1", to: { kind: "human", id: "grace" } },
    ]);
  });

  it("a blocked hand-back moves to blocked, assigns the requester and notifies them", () => {
    expect(
      run(
        ev("agent.handed_back", { ...tk, actor: agent, data: { status: "blocked" } }),
        world({ status: "active" }),
      ),
    ).toEqual([
      { type: "move", ticket: "ACME-1", to: "blocked" },
      { type: "assign", ticket: "ACME-1", to: { kind: "human", id: "grace" } },
      expect.objectContaining({
        type: "notify",
        to: { kind: "human", id: "grace" },
        template: "hand_back_blocked",
        ticket: "ACME-1",
      }),
    ]);
  });

  it("a waiting hand-back changes nothing", () => {
    expect(
      run(
        ev("agent.handed_back", { ...tk, actor: agent, data: { status: "waiting" } }),
        world({ status: "active" }),
      ),
    ).toEqual([]);
  });

  it("a blocked hand-back leaves a done ticket alone", () => {
    expect(
      run(
        ev("agent.handed_back", { ...tk, actor: agent, data: { status: "blocked" } }),
        world({ status: "done" }),
      ),
    ).toEqual([]);
  });

  it("hand-back leaves a done ticket alone", () => {
    expect(
      run(
        ev("agent.handed_back", { actor: agent, data: { status: "done" } }),
        world({ status: "done" }),
      ),
    ).toEqual([]);
  });

  it("hand-back falls back to the first listed human when the ticket has no requester", () => {
    const state = world({ status: "active", ticket: { requester: undefined as never } });
    const handBack = ev("agent.handed_back", { ...tk, actor: agent, data: { status: "done" } });
    expect(evaluateWorkflow(handBack, state, kanban, { fallbackRequester: "ada.admin" })).toEqual([
      { type: "move", ticket: "ACME-1", to: "review" },
      { type: "assign", ticket: "ACME-1", to: { kind: "human", id: "ada.admin" } },
    ]);

    // A known requester beats the fallback.
    expect(
      evaluateWorkflow(handBack, world({ status: "active" }), kanban, {
        fallbackRequester: "ada.admin",
      }),
    ).toContainEqual({ type: "assign", ticket: "ACME-1", to: { kind: "human", id: "grace" } });
  });

  it("hand-back without a requester or a humans list skips the assignment and names the ticket", () => {
    const state = world({ status: "active", ticket: { requester: undefined as never } });
    const x = explainWorkflow(
      ev("agent.handed_back", { ...tk, actor: agent, data: { status: "done" } }),
      state,
      kanban,
    );

    expect(x.effects).toEqual([{ type: "move", ticket: "ACME-1", to: "review" }]);
    expect(x.rules.find((r) => r.id === "hand-back-to-requester")?.skipped).toEqual([
      "assign: ticket ACME-1 has no known requester and there is no first-human fallback (the team lists no humans, or policies.hand_back.fallback is none)",
    ]);
  });

  it("resolves the fallback requester from the first listed human", () => {
    const humans = [
      { name: "Ada", identities: { tracker: "ada.admin" } },
      { name: "Grace", identities: { vcs: "grace" } },
    ];

    expect(resolveWorkflow(undefined, humans).options.fallbackRequester).toBe("ada.admin");
    expect(resolveWorkflow(undefined, [humans[1]!]).options.fallbackRequester).toBe("Grace");
    expect(resolveWorkflow(undefined).options.fallbackRequester).toBeUndefined();
  });

  describe("policy switches", () => {
    const ids = (policies?: Record<string, unknown>, rules?: unknown[]) => {
      const parsed = parseTeamConfig({
        ...baseConfig(),
        ...(rules ? { workflow: { rules } } : {}),
        ...(policies ? { policies } : {}),
      });

      if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
      }

      return resolveWorkflow(parsed.config.workflow, parsed.config.humans, parsed.config.policies);
    };

    const has = (w: { rules: Rule[] }, id: string) => w.rules.some((r) => r.id === id);

    it("keeps every preset rule by default", () => {
      expect(ids().rules.map((r) => r.id)).toEqual(kanban.map((r) => r.id));
      expect(ids().switched).toEqual([]);
    });

    it("feedback.merged_prs and conflicts.follow_up remove their rule", () => {
      const w = ids({ feedback: { merged_prs: false }, conflicts: { follow_up: false } });
      expect(has(w, "merged-feedback-follow-up")).toBe(false);
      expect(has(w, "conflict-back-to-author")).toBe(false);
      expect(w.switched.map((s) => [s.rule, s.switch, s.effect])).toEqual([
        ["merged-feedback-follow-up", "feedback.merged_prs", "removed"],
        ["conflict-back-to-author", "conflicts.follow_up", "removed"],
      ]);
    });

    it("hand_back.reassign: none keeps the move to review and drops the assignment", () => {
      const rule = ids({ hand_back: { reassign: "none" } }).rules.find(
        (r) => r.id === "hand-back-to-requester",
      );

      expect(rule?.do).toEqual([{ move: "review" }]);
    });

    it("hand_back.reassign: none keeps the move to blocked and the notice, and drops the assignment", () => {
      const rule = ids({ hand_back: { reassign: "none" } }).rules.find(
        (r) => r.id === "hand-back-blocked-to-requester",
      );

      expect(rule?.do).toEqual([
        { move: "blocked" },
        { notify: { to: "requester", template: "hand_back_blocked" } },
      ]);
    });

    it("hand_back.fallback: none leaves out the first-human fallback", () => {
      expect(ids().options.fallbackRequester).toBe("Ada");
      expect(ids({ hand_back: { fallback: "none" } }).options.fallbackRequester).toBeUndefined();
    });

    it("an explicit workflow rule wins over a switch", () => {
      const own = {
        id: "conflict-back-to-author",
        on: "pr.conflicted",
        do: [{ notify: { to: "channel", template: "rebase_conflict" } }],
      };

      const w = ids({ conflicts: { follow_up: false } }, [own]);
      expect(w.rules.find((r) => r.id === "conflict-back-to-author")?.do).toEqual(own.do);

      const disabled = ids({}, [{ id: "conflict-back-to-author", disabled: true }]);
      expect(has(disabled, "conflict-back-to-author")).toBe(false);
    });
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

describe("a ticket created already assigned", () => {
  const a = { id: "ada", kind: "agent" as const };
  const created = ev("ticket.created", { ...tk });

  it("schedules the agent assignee, as a later assignment would", () => {
    for (const rules of [kanban, presetRules("minimal")]) {
      expect(run(created, world({ status: "ready", ticket: { assignee: a } }), rules)).toEqual([
        { type: "schedule", person: "ada", kind: "assigned", priority: "normal", ticket: "ACME-1" },
      ]);
    }
  });

  it("schedules nothing when unassigned, assigned to a human, created by automation or finished", () => {
    expect(run(created, world({ status: "ready" }))).toEqual([]);
    expect(run(created, world({ ticket: { assignee: { id: "grace", kind: "human" } } }))).toEqual(
      [],
    );

    expect(run({ ...created, actor: automation }, world({ ticket: { assignee: a } }))).toEqual([]);
    expect(run(created, world({ status: "done", ticket: { assignee: a } }))).toEqual([]);
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
      feedbackSchedule("ACME-1"),
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
      "merged-feedback-follow-up",
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

    expect(by["human-feedback-back-to-author"]).toMatchObject({ matched: true });
    expect(by["human-feedback-reactivates-ticket"]).toMatchObject({ matched: false });
    expect(by["human-feedback-reactivates-ticket"]?.reason).toBe(
      "ticket status active in [review, blocked]",
    );

    expect(x.effects).toEqual([
      expect.objectContaining({ type: "schedule", kind: "review_feedback" }),
    ]);
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

describe("one pull request per ticket", () => {
  const rulesFor = (prsPerTicket: "one" | "many"): Rule[] => {
    const parsed = parseTeamConfig({
      ...baseConfig(),
      policies: { tickets: { prs_per_ticket: prsPerTicket } },
    });

    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.issues));
    }

    return resolveWorkflow(parsed.config.workflow, parsed.config.humans, parsed.config.policies)
      .rules;
  };

  const many = rulesFor("many");
  const merged = (n: number) => pr(n, { state: "merged" });
  const closed = (n: number) => pr(n, { state: "closed" });
  const handBack = (status: string) =>
    ev("agent.handed_back", { ...tk, actor: agent, data: { status } });

  const done = { type: "move", ticket: "ACME-1", to: "done" };
  const toReview = { type: "move", ticket: "ACME-1", to: "review" };

  it("with one, a merge moves the ticket to done even when another pull request is open", () => {
    expect(run(ev("pr.merged"), world({ status: "review", prs: [merged(10), pr(11)] }))).toEqual([
      done,
    ]);
  });

  it("with many, a merge alone does not move the ticket", () => {
    const state = world({ status: "review", prs: [merged(10)] });
    expect(run(ev("pr.merged"), state, many)).toEqual([]);
    expect(
      run(ev("pr.merged"), world({ status: "review", prs: [merged(10), pr(11)] }), many),
    ).toEqual([]);
  });

  it("with many, the last merge closes the ticket once the agent handed it back as done", () => {
    const state = world({
      status: "review",
      ticket: { handedBack: true },
      prs: [merged(10), merged(11)],
    });

    expect(run(ev("pr.merged", { subject: { pr: ref(11) } }), state, many)).toEqual([done]);

    // Another pull request is still open: not yet.
    const open = world({
      status: "review",
      ticket: { handedBack: true },
      prs: [merged(10), pr(11)],
    });

    expect(run(ev("pr.merged"), open, many)).toEqual([]);
  });

  it("with many, the hand-back as done closes a ticket whose pull requests are all closed", () => {
    const settled = world({ status: "active", prs: [merged(10), merged(11)] });
    expect(run(handBack("done"), settled, many)).toEqual([done]);

    // Not settled: it goes to review for the requester, as before.
    const open = world({ status: "active", prs: [merged(10), pr(11)] });
    expect(run(handBack("done"), open, many)).toEqual([
      toReview,
      { type: "assign", ticket: "ACME-1", to: { kind: "human", id: "grace" } },
    ]);

    // Waiting or blocked never closes it.
    expect(run(handBack("waiting"), settled, many)).toEqual([]);
    expect(run(handBack("blocked"), settled, many)).toContainEqual({
      type: "move",
      ticket: "ACME-1",
      to: "blocked",
    });
  });

  it("with many, a pull request closed without merging closes the ticket after the others merged", () => {
    const state = world({
      status: "review",
      ticket: { handedBack: true },
      prs: [merged(10), closed(11)],
    });

    expect(run(ev("pr.closed", { subject: { pr: ref(11) } }), state, many)).toEqual([done]);
  });

  it("with many, a closed pull request does not send the ticket back while others are open or merged", () => {
    expect(
      run(ev("pr.closed"), world({ status: "review", prs: [closed(10), merged(11)] }), many),
    ).toEqual([]);

    // Closing one of two open pull requests leaves the ticket where it is.
    expect(
      run(ev("pr.closed"), world({ status: "review", prs: [closed(10), pr(11)] }), many),
    ).toEqual([]);

    // Nothing merged and none left open: back to ready, as with one.
    expect(run(ev("pr.closed"), world({ status: "review", prs: [closed(10)] }), many)).toEqual([
      { type: "move", ticket: "ACME-1", to: "ready" },
    ]);
  });

  it("with many, a ticket whose only pull request closed unmerged is not settled", () => {
    const state = world({ status: "active", prs: [closed(10)] });
    expect(run(handBack("done"), state, many)).toEqual([
      toReview,
      { type: "assign", ticket: "ACME-1", to: { kind: "human", id: "grace" } },
    ]);
  });

  describe("a person opens a second pull request", () => {
    const opened = (n: number) => ev("pr.opened", { subject: { pr: ref(n) } });
    const human = { login: "grace-lead", kind: "human" as const };
    const second = world({
      status: "review",
      prs: [pr(10), pr(11, { author: human })],
    });

    it("comments on the ticket, saying which merge closes it", () => {
      const comment = run(opened(11), second).find((e) => e.type === "comment");
      expect(comment).toMatchObject({ type: "comment", on: { ticket: "ACME-1" } });
      expect(comment && "body" in comment && comment.body).toContain("2 pull requests");
      expect(comment && "body" in comment && comment.body).toContain("#10 Change 10");
      expect(comment && "body" in comment && comment.body).toContain("#11 Change 11");
      expect(comment && "body" in comment && comment.body).toContain("merges first closes");
    });

    it("says what closes the ticket with many", () => {
      const comment = run(opened(11), second, many).find((e) => e.type === "comment");
      expect(comment && "body" in comment && comment.body).toContain(
        "handed its work back as done",
      );
    });

    it("does not comment on a first pull request, an agent's or a closed one", () => {
      const comments = (state: ReturnType<typeof world>, n: number) =>
        run(opened(n), state).filter((e) => e.type === "comment");

      expect(comments(world({ prs: [pr(10, { author: human })] }), 10)).toEqual([]);
      expect(comments(world({ prs: [pr(10), pr(11)] }), 11)).toEqual([]);
      expect(comments(world({ prs: [closed(10), pr(11, { author: human })] }), 11)).toEqual([]);

      expect(
        comments(world({ status: "done", prs: [merged(10), pr(11, { author: human })] }), 11),
      ).toEqual([]);
    });
  });

  it("every rewritten preset rule is valid and the default switch changes nothing", () => {
    for (const rule of many) {
      expect({ id: rule.id, valid: ruleInputSchema.safeParse(rule).success }).toEqual({
        id: rule.id,
        valid: true,
      });
    }

    expect(rulesFor("one")).toEqual(kanban);
  });
});
