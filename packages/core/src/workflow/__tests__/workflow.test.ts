import { describe, expect, it } from "vitest";
import { parseTeamConfig } from "#/config/parse.js";
import { buildTeamJsonSchema } from "#/config/json-schema.js";
import { agent, automation, ev, pr, ref, world } from "./fixtures.js";
import { createStaticWorkflowState } from "#/workflow/state.js";
import {
  checkCondition,
  createEvaluationContext,
  resolvePerson,
  templateVariables,
} from "#/workflow/evaluate.js";
import { workflowOptions } from "#/workflow/options.js";
import { createStatusMap } from "#/workflow/status-map.js";
import { renderTemplate, TemplateError, templatePlaceholders } from "#/workflow/template.js";
import type {
  Condition,
  WorkflowEvent,
  WorkflowOptions,
  WorkflowPr,
  WorkflowState,
} from "#/workflow/types.js";

const holds = (
  c: Condition,
  event: WorkflowEvent = ev("pr.opened"),
  state: WorkflowState = world(),
  opts: WorkflowOptions = {},
) => checkCondition(c, createEvaluationContext(event, state, opts));

const ok = (...args: Parameters<typeof holds>) => holds(...args).ok;
const tk = { subject: { ticket: "ACME-1" } };
const noTicket = () => ev("pr.opened", { subject: { pr: ref(99) } });

const base = {
  version: 1,
  team: { name: "acme" },
  catalog: { version: "1.0.0" },
  repos: [{ name: "app", url: "github.com/acme/app", kind: "primary" }],
  people: [{ handle: "ada", name: "Ada", role: "r", model: "sonnet" }],
  integrations: { chat: { adapter: "a" }, vcs: { adapter: "b" }, runtime: { adapter: "c" } },
};

describe("conditions", () => {
  it("combine with all, any and not, saying which part decided", () => {
    expect(ok({ all: [{ actor_kind: "human" }, { pr_open: true }] })).toBe(true);
    expect(holds({ all: [{ actor_kind: "human" }, { pr_draft: true }] }).detail).toContain("draft");

    expect(ok({ any: [{ actor_kind: "agent" }, { pr_open: true }] })).toBe(true);
    expect(holds({ any: [{ actor_kind: "agent" }, { pr_draft: true }] }).detail).toMatch(
      /^none of: actor is human.*draft/,
    );

    expect(holds({ not: { actor_kind: "agent" } }).detail).toContain("not-condition holds");
    expect(holds({ not: { actor_kind: "human" } }).detail).toMatch(/^not \(/);
  });

  it("read the ticket's status, through the pull request's link when the event names no ticket", () => {
    expect(ok({ ticket_status: ["review"] })).toBe(true);
    expect(ok({ ticket_status: ["review"] }, noTicket())).toBe(false);
    expect(holds({ ticket_status: ["review"] }, noTicket()).detail).toContain(
      "none (no linked ticket)",
    );

    expect(
      holds({ ticket_status: ["review"] }, ev("ticket.moved", { subject: { ticket: "X-9" } }))
        .detail,
    ).toContain("unknown");
  });

  it("match a move by its canonical status and name the tracker's", () => {
    const moved = (data: Record<string, unknown>) => ev("ticket.moved", { ...tk, data });
    expect(ok({ moved_to: ["active"] }, moved({ to: "active", toName: "In Progress" }))).toBe(true);

    expect(holds({ moved_to: ["active"] }, moved({ toName: "Doing" })).detail).toContain(
      "Doing (unmapped)",
    );

    expect(holds({ moved_to: ["active"] }, moved({})).detail).toContain("moved to none");
    expect(ok({ moved_to: ["active"] }, moved({ to: "review" }))).toBe(false);
  });

  it("read who acted and who has the ticket", () => {
    expect(ok({ actor_kind: "agent" }, ev("pr.opened", { actor: agent }))).toBe(true);
    expect(ok({ actor_kind: "automation" }, ev("pr.opened", { actor: automation }))).toBe(true);
    const assigned = world({ ticket: { assignee: { kind: "agent", id: "ada" } } });
    expect(ok({ assignee_kind: "agent" }, ev("pr.opened"), assigned)).toBe(true);
    expect(ok({ assignee_kind: "none" })).toBe(true);
    expect(ok({ assignee_kind: "none" }, noTicket())).toBe(true);
  });

  it("read labels, with $needs_human as the team's label", () => {
    const labelled = world({ ticket: { labels: ["needs-human", "hold"] } });
    expect(ok({ has_label: "$needs_human" }, ev("pr.opened"), labelled)).toBe(true);
    expect(ok({ has_label: "hold" }, ev("pr.opened"), labelled)).toBe(true);
    const held = world({ ticket: { labels: ["hold"] } });
    expect(ok({ has_label: "$needs_human" }, ev("pr.opened"), held)).toBe(false);
    expect(
      ok({ has_label: "$needs_human" }, ev("pr.opened"), held, { needsHumanLabel: "hold" }),
    ).toBe(true);

    expect(ok({ has_label: "hold" }, noTicket())).toBe(false);
  });

  it("read the pull request: author, draft, open, merged and its base", () => {
    const byHuman = world({ prs: [pr(10, { author: { login: "grace", kind: "human" } })] });
    expect(ok({ pr_author_kind: "human" }, ev("pr.opened"), byHuman)).toBe(true);
    expect(ok({ pr_draft: false })).toBe(true);
    expect(ok({ pr_open: true })).toBe(true);
    expect(ok({ pr_merged: false })).toBe(true);
    expect(ok({ pr_base_default: true })).toBe(true);
    const stacked = world({ prs: [pr(10, { baseRef: "feat-9" })] });
    expect(ok({ pr_base_default: false }, ev("pr.opened"), stacked)).toBe(true);

    const none = ev("pr.opened", tk);
    for (const c of [
      { pr_author_kind: "agent" },
      { pr_draft: false },
      { pr_open: true },
      { pr_merged: false },
      { pr_base_default: true },
    ] as Condition[]) {
      const r = holds(c, none);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain("unknown");
    }
  });

  it("read a review or comment: its body, its state and the agents it mentions", () => {
    const review = (data: Record<string, unknown>) => ev("pr.review_submitted", { data });
    expect(ok({ has_body: true }, review({ body: "fix it" }))).toBe(true);
    expect(ok({ has_body: true }, review({ body: " ", comments: [{ body: "x" }] }))).toBe(true);
    expect(ok({ has_body: false }, review({ body: "  " }))).toBe(true);
    expect(ok({ review_state: ["approved"] }, review({ state: "approved" }))).toBe(true);
    expect(holds({ review_state: ["approved"] }, review({})).detail).toContain("none");

    const mention = ev("ticket.commented", { ...tk, data: { mentions: ["ada", "ada", "", 3] } });
    expect(holds({ agent_mentioned: true }, mention).detail).toContain("[ada]");
    expect(ok({ agent_mentioned: false }, ev("ticket.commented", tk))).toBe(true);
    expect(
      ok({ agent_mentioned: true }, ev("ticket.commented", { ...tk, data: { mentions: "ada" } })),
    ).toBe(false);
  });

  it("read a hand-back's status and the kind of its item", () => {
    const back = ev("agent.handed_back", { ...tk, data: { status: "done", kind: "assigned" } });
    expect(ok({ hand_back_status: ["done"] }, back)).toBe(true);
    expect(ok({ work_kind: ["assigned"] }, back)).toBe(true);
    const bare = ev("agent.handed_back", tk);
    expect(holds({ hand_back_status: ["done"] }, bare).detail).toContain("none");
    expect(holds({ work_kind: ["assigned"] }, bare).detail).toContain("unknown");
  });

  it("judge approvals by the allowed approvers", () => {
    expect(ok({ approver: true })).toBe(true);
    expect(ok({ approver: false }, ev("pr.opened", { data: { untrusted: true } }))).toBe(true);
    expect(ok({ approver: true }, ev("pr.opened", { actor: agent }))).toBe(false);
    expect(
      ok({ approver: true }, ev("pr.opened", { actor: { kind: "agent", id: "rex" } }), world(), {
        approvers: ["role:reviewer"],
      }),
    ).toBe(true);

    const verdicts = (v: NonNullable<WorkflowPr["verdicts"]>) =>
      world({ prs: [pr(10, { verdicts: v })] });

    expect(
      ok(
        { pr_approved: true },
        ev("pr.opened"),
        verdicts([{ actor: "grace", kind: "human", state: "approved" }]),
      ),
    ).toBe(true);

    const blocked = holds(
      { pr_approved: true },
      ev("pr.opened"),
      verdicts([
        { actor: "grace", kind: "human", state: "approved" },
        { actor: "linus", kind: "human", state: "changes_requested" },
      ]),
    );

    expect(blocked.ok).toBe(false);
    expect(blocked.detail).toContain("changes requested");
    expect(holds({ pr_approved: false }).detail).toContain("0 allowed approver verdicts");
  });

  it("count the ticket's pull requests", () => {
    const prs = (...states: ("open" | "closed" | "merged")[]) =>
      world({ prs: states.map((state, i) => pr(10 + i, { state })) });

    expect(ok({ ticket_prs_open: true }, ev("pr.opened"), prs("open"))).toBe(true);
    expect(ok({ ticket_prs_open: false }, ev("pr.opened"), prs("merged"))).toBe(true);
    expect(ok({ ticket_prs_several: true }, ev("pr.opened"), prs("open", "merged"))).toBe(true);
    expect(ok({ ticket_prs_several: false }, ev("pr.opened"), prs("open", "closed"))).toBe(true);
    expect(ok({ ticket_prs_all_closed: true }, ev("pr.opened"), prs("merged", "closed"))).toBe(
      true,
    );

    expect(ok({ ticket_prs_all_closed: true }, ev("pr.opened"), prs("closed"))).toBe(false);
    expect(holds({ ticket_prs_all_closed: false }, ev("pr.opened"), prs("open")).detail).toBe(
      "ticket has 1 pull request, 0 merged, 1 open; wanted not all closed with one merged",
    );

    expect(ok({ ticket_prs_open: false }, noTicket())).toBe(true);
  });

  it("read whether the ticket was handed back as done", () => {
    const back = world({ ticket: { handedBack: true } });
    expect(ok({ ticket_handed_back: true }, ev("pr.opened"), back)).toBe(true);
    expect(holds({ ticket_handed_back: true }).detail).toContain("was not");
    expect(ok({ ticket_handed_back: false }, noTicket())).toBe(true);
  });
});

describe("people", () => {
  const ctx = (event: WorkflowEvent, state: WorkflowState = world()) =>
    createEvaluationContext(event, state);

  it("resolve the author, the assignee, the last worker, the first mention, a document's author and a role", () => {
    const assigned = world({ ticket: { assignee: { kind: "agent", id: "sam" } } });
    expect(resolvePerson("author", ctx(ev("pr.opened")))).toEqual({ value: "ada" });
    expect(resolvePerson("assignee", ctx(ev("pr.opened"), assigned))).toEqual({ value: "sam" });
    expect(resolvePerson("last_worker", ctx(ev("pr.opened")))).toEqual({ value: "ada" });
    expect(
      resolvePerson("mentioned", ctx(ev("ticket.commented", { data: { mentions: ["rex"] } }))),
    ).toEqual({ value: "rex" });

    expect(
      resolvePerson("doc_author", ctx(ev("doc.commented", { subject: { doc: "doc-1" } }))),
    ).toEqual({ value: "ada" });

    expect(resolvePerson("role:pm", ctx(ev("pr.opened")))).toEqual({ value: "pia" });
  });

  it("say why nobody resolves", () => {
    const none = ev("doc.commented", { subject: {} });
    const humanPr = world({ prs: [pr(10, { author: { login: "grace", kind: "human" } })] });
    expect(resolvePerson("author", ctx(ev("pr.opened"), humanPr))).toEqual({
      skip: "pull request has no agent author",
    });

    expect(resolvePerson("assignee", ctx(none))).toEqual({
      skip: "ticket is not assigned to an agent",
    });

    expect(resolvePerson("last_worker", ctx(none))).toEqual({
      skip: "no agent has worked on the ticket yet",
    });

    expect(resolvePerson("mentioned", ctx(none))).toEqual({
      skip: "the comment mentions no agent",
    });

    expect(resolvePerson("doc_author", ctx(none))).toEqual({
      skip: "no agent is recorded as the author of the document",
    });

    expect(resolvePerson("role:qa", ctx(none))).toEqual({ skip: "no agent plays role:qa" });
  });
});

describe("template variables", () => {
  it("fill every variable, empty when the event has no ticket or pull request", () => {
    const vars = templateVariables(
      createEvaluationContext(ev("doc.commented", { subject: {} }), world()),
    );

    expect(vars["ticket"]).toBe("");
    expect(vars["pr.number"]).toBe("");
    expect(vars["stack.count"]).toBe("0");
  });

  it("list the stack bottom first and the ticket's live pull requests, and survive cyclic data", () => {
    const state = createStaticWorkflowState({
      tickets: { "ACME-1": { status: "active" } },
      prs: [
        pr(10),
        (({ url: _url, ...rest }) => rest)(pr(12, { baseRef: "feat-10" })),
        pr(11, { baseRef: "feat-10", state: "closed" }),
        pr(13, { baseRef: "feat-12", headRef: "feat-10" }),
      ],
      links: { 10: "ACME-1", 11: "ACME-1", 12: "ACME-1" },
    });

    const vars = templateVariables(createEvaluationContext(ev("pr.conflicted"), state));
    expect(vars["stack"]).toBe(
      [
        "1. #10 Change 10 (https://git.example/acme/app/pull/10)",
        "2. #11 Change 11 (https://git.example/acme/app/pull/11)",
        "3. #12 Change 12",
        "4. #13 Change 13 (https://git.example/acme/app/pull/13)",
      ].join("\n"),
    );

    expect(vars["ticket.prs.count"]).toBe("2");
    expect(vars["pr.author"]).toBe("ada");
    expect(vars["status"]).toBe("active");
    const byHuman = createStaticWorkflowState({
      prs: [pr(10, { author: { login: "grace", kind: "human" } })],
    });

    expect(templateVariables(createEvaluationContext(ev("pr.opened"), byHuman))["pr.author"]).toBe(
      "grace",
    );
  });
});

describe("options", () => {
  it("take the label, the approvers, the humans and the first human as the fallback requester", () => {
    const humans = [
      { name: "Grace", identities: { tracker: "grace.t" } },
      { name: "Linus", identities: {} },
    ];

    expect(workflowOptions({ humans })).toEqual({
      needsHumanLabel: "needs-human",
      approvers: ["humans"],
      humans,
      fallbackRequester: "grace.t",
    });

    expect(workflowOptions({ humans: [humans[1]!] }).fallbackRequester).toBe("Linus");
    expect(workflowOptions({}).fallbackRequester).toBeUndefined();
  });

  it("leave out the fallback when the team turns it off, and read the label and approvers", () => {
    const parsed = parseTeamConfig({
      ...base,
      humans: [{ name: "Grace", identities: { tracker: "grace" } }],
      workflow: { needs_human_label: "hold" },
      policies: { hand_back: { fallback: "none" }, merge: { approvers: ["role:reviewer"] } },
    });

    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.issues));
    }

    const opts = workflowOptions(parsed.config);
    expect(opts.fallbackRequester).toBeUndefined();
    expect(opts.needsHumanLabel).toBe("hold");
    expect(opts.approvers).toEqual(["role:reviewer"]);
  });
});

describe("config validation", () => {
  const issues = (workflow: unknown) => {
    const r = parseTeamConfig({ ...base, workflow });
    return r.ok ? [] : r.issues.map((i) => [i.code, i.message]);
  };

  it("reports two canonical statuses mapped to one tracker name", () => {
    expect(issues({ statuses: { review: "Doing", active: "doing" } })).toEqual([
      [
        "workflow.duplicate_status_name",
        'Status name "doing" is used for both "review" and "active".',
      ],
    ]);

    expect(issues({ statuses: { review: "In Review", active: "In Progress" } })).toEqual([]);
  });

  it("reports the preset, the rules and the templates as removed keys", () => {
    for (const [key, value] of [
      ["preset", "kanban"],
      ["rules", []],
      ["templates", {}],
    ] as const) {
      const found = issues({ [key]: value });
      expect(found).toHaveLength(1);
      expect(found[0]![0]).toBe("schema.removed_key");
      expect(found[0]![1]).toContain(`workflow.${key} was removed`);
    }
  });

  it("publishes the conditions in the JSON Schema", () => {
    const json = JSON.stringify(buildTeamJsonSchema());
    expect(json).toContain("ticket_status");
    expect(json).toContain("needs_human_label");
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
    expect(templatePlaceholders("{{a}} and {{ b.c }}")).toEqual(["a", "b.c"]);
  });
});

describe("static state", () => {
  it("answers from plain data, with defaults for what it does not have", () => {
    const s = createStaticWorkflowState({});
    expect(s.ticketForPr(ref(1))).toBeUndefined();
    expect(s.pullRequestsOf("ACME-1")).toEqual([]);
    expect(s.handedBack("ACME-1")).toBe(false);
    expect(s.hasLabel("ACME-1", "x")).toBe(false);
    expect(s.defaultBranch(ref(1).repo)).toBe("main");
    expect(s.stackedOn(ref(1).repo, "main")).toEqual([]);
    expect(s.docAuthor("d")).toBeUndefined();
    expect(s.personForRole("pm")).toBeUndefined();
  });
});
