import type { StandInReply } from "@outstaff/testing.http";
import type {
  ColumnSpec,
  ItsaplanStore,
  PullRequestSource,
  StandInOptions,
  StoredMember,
} from "./types.js";

/** The Title Case statuses that match the canonical workflow. */
export const DEFAULT_COLUMNS: ColumnSpec[] = [
  { name: "Backlog", stateType: "backlog" },
  { name: "Ready", stateType: "unstarted" },
  { name: "In Progress", stateType: "started" },
  { name: "Review", stateType: "started" },
  { name: "Blocked", stateType: "started" },
  { name: "Done", stateType: "completed" },
  { name: "Canceled", stateType: "canceled" },
];

export const DEFAULT_MEMBERS: StoredMember[] = [
  { userId: "u-sam", name: "Sam Duarte", username: "sam", kind: "member" },
  { userId: "u-rio", name: "Rio Park", username: "rio", kind: "member" },
];

/** An error as Its a Plan answers it. */
export const err = (status: number, error: string, code?: string): StandInReply => ({
  status,
  body: { error, ...(code ? { code } : {}) },
});

/** A clock that starts at 2026-01-01T00:00:00Z and moves a second each time it is read. */
export function tickingClock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + ++tick * 1000).toISOString();
}

/** The development section's data: the connected repositories, their pull requests and the links made. */
function development(opts: StandInOptions) {
  const pullRequests: ItsaplanStore["pullRequests"] = new Map();
  const own: PullRequestSource = (repo) => pullRequests.get(repo.id) ?? [];
  return {
    repositories: [...(opts.repositories ?? [])],
    pullRequests,
    pullRequestsOf: opts.pullRequests ?? own,
    development: [],
  };
}

export function createStore(opts: StandInOptions): ItsaplanStore {
  const key = opts.projectKey ?? "SHOP";
  const teamRef = opts.teamRef ?? "acme";
  return {
    key,
    teamRef,
    ref: `${teamRef}.${key}`,
    now: opts.now ?? tickingClock(),
    keys: opts.keys ?? { "key-sam": "u-sam" },
    project: { id: 1, teamId: 1, teamName: "Acme", name: "Shop", ...opts.project },
    documents: opts.documents ?? {},
    columns: (opts.columns ?? DEFAULT_COLUMNS).map((c, i) => ({
      id: 10 + i,
      projectId: 1,
      position: i,
      ...c,
    })),
    labels: [],
    members: [...(opts.members ?? DEFAULT_MEMBERS)],
    issues: [],
    activity: [],
    links: [],
    attachments: [],
    served: [],
    docs: [],
    docComments: [],
    ...development(opts),
    counters: { activity: 100, label: 500, doc: 0, comment: 0, link: 0 },
  };
}
