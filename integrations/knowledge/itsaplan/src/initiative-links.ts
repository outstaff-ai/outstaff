import { PortError, type DocIssueLinkOutcome, type IssueDoc } from "@outstaff/core";
import type { ApiIssueDoc, Itsaplan } from "@outstaff/integration.shared.itsaplan";

/**
 * Documents linked to initiatives (the roadmap's milestones): Its a Plan's links between a Docs page and an initiative
 * of the tracker, by the initiative's id. A link that exists already is left as it is.
 */
export function initiativeLinkHelpers(api: Itsaplan, idOf: (idOrPath: string) => Promise<number>) {
  const docs = `${api.projectPath}/documents`;
  const initiativeDocs = async (initiativeId: string): Promise<IssueDoc[]> => {
    const path = `${docs}/for-initiative/${encodeURIComponent(initiativeId)}`;
    const list = await api.http.request<ApiIssueDoc[]>("GET", path);
    return list.map((d) => ({ id: String(d.documentId), title: d.title }));
  };

  return {
    initiativeDocs,

    async linkInitiative(docId: string, initiativeId: string): Promise<DocIssueLinkOutcome> {
      const id = await idOf(docId);
      if ((await initiativeDocs(initiativeId)).some((d) => d.id === String(id))) {
        return "already_linked";
      }

      try {
        await api.http.request("POST", `${docs}/${id}/initiatives`, {
          body: { initiativeId: Number(initiativeId) },
        });
      } catch (error) {
        // Linked meanwhile: the API refuses a second link.
        if (error instanceof PortError && error.code === "conflict") {
          return "already_linked";
        }

        throw error;
      }

      return "linked";
    },
  };
}
