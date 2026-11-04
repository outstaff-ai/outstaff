import type {
  Initiative,
  InitiativeChanges,
  InitiativeFilter,
  InitiativeRef,
  InitiativeStatus,
  Issue,
  NewInitiative,
} from "@outstaff/core";
import type {
  ApiInitiative,
  ApiInitiativePage,
  ApiIssue,
  Itsaplan,
} from "@outstaff/integration.shared.itsaplan";

/** Its a Plan's statuses as the port's; a proposed initiative is planned too. */
const FROM_API: Record<string, InitiativeStatus> = {
  proposed: "planned",
  planned: "planned",
  active: "active",
  completed: "done",
  canceled: "canceled",
};

const TO_API: Record<InitiativeStatus, string> = {
  planned: "planned",
  active: "active",
  done: "completed",
  canceled: "canceled",
};

/** The most initiatives one page of the listing has; a roadmap has far fewer milestones. */
const PAGE = 100;

/** The initiative a read of one issue names: null for none, absent when the answer does not say (a listing). */
export function initiativeOfIssue(raw: ApiIssue): Pick<Issue, "initiative"> {
  if (raw.initiative === undefined) {
    return {};
  }

  const ref: InitiativeRef | null = raw.initiative
    ? { id: String(raw.initiative.id), title: raw.initiative.title }
    : null;

  return { initiative: ref };
}

/** The body fields of a create or a change; a field left out stays out. */
const body = (c: InitiativeChanges): Record<string, unknown> => ({
  ...(c.title === undefined ? {} : { title: c.title }),
  ...(c.description === undefined ? {} : { description: c.description }),
  ...(c.status === undefined ? {} : { status: TO_API[c.status] }),
});

/**
 * Initiatives, the roadmap's milestones: the project's list (in the manual order Its a Plan keeps), one by id, made
 * and changed, and an issue put in or out of one (the issue's `initiativeId`).
 */
export function initiativeHelpers(
  api: Itsaplan,
  patch: (key: string, body: Record<string, unknown>) => Promise<Issue>,
) {
  const toInitiative = (raw: ApiInitiative): Initiative => ({
    id: String(raw.id),
    title: raw.title,
    description: raw.description,
    status: FROM_API[raw.status] ?? "planned",
    url: api.initiativeUrl(String(raw.id)),
    updatedAt: raw.updatedAt,
  });

  return {
    async initiatives(filter: InitiativeFilter = {}): Promise<Initiative[]> {
      const status = filter.status?.map((s) => TO_API[s]).join(",");
      const res = await api.http.request<ApiInitiativePage>(
        "GET",
        `${api.projectPath}/initiatives`,
        {
          query: { status, pageSize: PAGE },
        },
      );

      return res.items.map(toInitiative);
    },

    async getInitiative(id: string): Promise<Initiative> {
      return toInitiative(await api.http.request<ApiInitiative>("GET", `/initiatives/${id}`));
    },

    async createInitiative(input: NewInitiative): Promise<Initiative> {
      const made = await api.http.request<ApiInitiative>("POST", `${api.projectPath}/initiatives`, {
        body: body({ status: "planned", ...input }),
      });

      return toInitiative(made);
    },

    async updateInitiative(id: string, changes: InitiativeChanges): Promise<Initiative> {
      const updated = await api.http.request<ApiInitiative>("PATCH", `/initiatives/${id}`, {
        body: body(changes),
      });

      return toInitiative(updated);
    },

    async setInitiative(key: string, initiativeId: string | null): Promise<Issue> {
      return patch(key, { initiativeId: initiativeId === null ? null : Number(initiativeId) });
    },
  };
}
