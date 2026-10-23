/** What the office tells an agent; the wire protocol is defined separately (the verbs only need this). */
export interface OfficeWorkItem {
  id: string;
  title: string;
  status: string;

  /** The ticket the work item is about, when it has one. */
  ticketKey?: string;
  prUrl?: string;
  current?: boolean;
}

export interface OfficeTeamMember {
  handle: string;
  name: string;
  role: string;
  title?: string;
  summary?: string;
  status: "idle" | "working" | "paused" | "offline";
  current?: string;
}

export interface OfficeTeam {
  members: OfficeTeamMember[];

  /** The trusted humans. */
  humans: { name: string }[];
}

export interface OfficeAnswer {
  id: string;
  to: string;
  status: "answered" | "pending";
  answer?: string;
}

export interface OfficeClient {
  /** Ask a teammate a question; the office routes it and may answer later. */
  ask(q: { to: string; question: string; workItemId?: string }): Promise<OfficeAnswer>;

  /** Answer a question the office routed to the caller. */
  answer(questionId: string, answer: string): Promise<void>;

  /** The caller's work items. */
  work(q: { workItemId?: string }): Promise<OfficeWorkItem[]>;
  team(): Promise<OfficeTeam>;
}

export interface FakeOffice extends OfficeClient {
  asked: { to: string; question: string; workItemId?: string }[];
  answered: { questionId: string; answer: string }[];
}

export function createFakeOffice(
  opts: {
    items?: OfficeWorkItem[];
    team?: OfficeTeamMember[];
    humans?: { name: string }[];
    answer?: (to: string, question: string) => string | undefined;
  } = {},
): FakeOffice {
  const asked: FakeOffice["asked"] = [];
  const answered: FakeOffice["answered"] = [];
  return {
    asked,
    answered,
    async answer(questionId, answer) {
      answered.push({ questionId, answer });
    },
    async ask(q) {
      asked.push(q);
      const answer = opts.answer?.(q.to, q.question);
      return {
        id: `q-${asked.length}`,
        to: q.to,
        status: answer === undefined ? "pending" : "answered",
        ...(answer === undefined ? {} : { answer }),
      };
    },
    async work(q) {
      const items = opts.items ?? [];
      return items.map((i) => ({ ...i, current: i.id === q.workItemId }));
    },
    async team() {
      return { members: opts.team ?? [], humans: opts.humans ?? [] };
    },
  };
}
