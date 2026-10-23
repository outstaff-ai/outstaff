import type { EventPage } from "./events.js";
import type { Links } from "./links.js";
import type { CanonicalStatus } from "./status.js";

export interface Member {
  id: string;
  name: string;
  username?: string;
  kind: "human" | "agent";
}

export interface Issue {
  key: string;
  id: string;
  title: string;
  body: string;
  status: { name: string; canonical?: CanonicalStatus };
  assignee?: Member;
  labels: string[];
  url: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  author: Member;
  body: string;
  url: string;
  at: string;
}

export interface TrackerEvent {
  externalId: string;
  type: "created" | "assigned" | "moved" | "commented";
  key: string;
  actor: Member;
  at: string;
  data: Record<string, unknown>;
}

export interface NewIssue {
  title: string;
  body: string;
  status?: CanonicalStatus;
  assignee?: string;
  labels?: string[];
}

export interface Tracker {
  links: Pick<Links, "issue">;
  getIssue(key: string): Promise<Issue>;
  listIssues(filter: {
    assignee?: string;
    status?: CanonicalStatus;
    updatedSince?: string;
    limit?: number;
  }): Promise<Issue[]>;
  search(query: string, limit?: number): Promise<Issue[]>;
  createIssue(issue: NewIssue): Promise<Issue>;

  /** Status names come from `team.workflow.statuses` via a `StatusMap` the adapter builds at create. */
  transition(key: string, to: CanonicalStatus): Promise<Issue>;
  assign(key: string, memberId: string | null): Promise<Issue>;
  comment(key: string, body: string): Promise<{ id: string; url: string }>;
  listComments(key: string): Promise<Comment[]>;
  setLabels(key: string, add: string[], remove: string[]): Promise<Issue>;
  link(key: string, otherKey: string, relation: "blocks" | "relates" | "duplicates"): Promise<void>;
  members(): Promise<Member[]>;
  events(cursor?: string): Promise<EventPage<TrackerEvent>>;

  /** Webhook mode; same contract as `Vcs.parseWebhook`. */
  parseWebhook?(headers: Record<string, string | undefined>, body: string): Promise<TrackerEvent[]>;
}
