import type { CanonicalStatus, PrRef, PrVerdict, StaticTicket, WorkflowPr } from "@outstaff/core";
import type { PipelineEvent, PipelineEventType, PipelineSubject } from "../../../events.types.js";

/** The acme team's agents (examples/acme). */
const AGENTS = new Set(["priya", "tomas", "mira", "leo", "sam", "noor", "ines", "kofi"]);

export const REPO = { host: "github.com", owner: "acme-example", name: "shop" };
export const ROLES = {
  pm: "priya",
  product: "tomas",
  architect: "mira",
  designer: "leo",
  reviewer: "ines",
  devops: "kofi",
};

export const ref = (number: number): PrRef => ({ repo: REPO, number });

/** A time on the replay day, in minutes (and seconds) after 09:00 UTC. */
export const at = (minutes: number, seconds = 0): string =>
  new Date(Date.UTC(2026, 9, 5, 9, 0) + minutes * 60_000 + seconds * 1000).toISOString();

/** A pull request; `by` is an agent's handle or a human's login. */
export function pr(
  number: number,
  title: string,
  o: {
    by: string;
    head: string;
    base?: string;
    state?: WorkflowPr["state"];
    draft?: boolean;
    verdicts?: PrVerdict[];
  },
): WorkflowPr {
  const agent = AGENTS.has(o.by);
  return {
    ref: ref(number),
    title,
    url: `https://github.com/acme-example/shop/pull/${number}`,
    headRef: o.head,
    baseRef: o.base ?? "main",
    draft: o.draft ?? false,
    state: o.state ?? "open",
    author: agent
      ? { login: `acme-${o.by}[bot]`, kind: "agent", person: o.by }
      : { login: o.by, kind: "human" },
    ...(o.verdicts ? { verdicts: o.verdicts } : {}),
  };
}

/** A ticket; `to` is an agent's handle or a human's tracker id. */
export const ticket = (
  status: CanonicalStatus,
  to?: string,
  extra: Omit<StaticTicket, "status" | "assignee"> = {},
): StaticTicket => ({
  status,
  ...(to
    ? { assignee: { id: to, kind: AGENTS.has(to) ? ("agent" as const) : ("human" as const) } }
    : {}),
  requester: "ada.admin",
  ...extra,
});

export const approved = (actor = "ada-admin"): PrVerdict => ({
  actor,
  kind: "human",
  state: "approved",
});

/** An event; `by` is an agent's handle, a human's id, or "office" for the office itself. */
export function ev(
  id: string,
  type: PipelineEventType,
  by: string,
  subject: Omit<PipelineSubject, "pr"> & { pr?: number },
  when: string,
  data: Record<string, unknown> = {},
): PipelineEvent {
  const { pr: number, ...rest } = subject;
  return {
    id: `replay:${id}`,
    type,
    at: when,
    subject: { ...rest, ...(number === undefined ? {} : { pr: ref(number) }) },
    actor:
      by === "office"
        ? { kind: "automation", id: "office" }
        : { kind: AGENTS.has(by) ? "agent" : "human", id: by },
    data: { at: when, ...data },
  };
}
