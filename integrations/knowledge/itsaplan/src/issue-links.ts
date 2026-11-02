import { PortError, type DocIssueLinkOutcome, type IssueDoc } from "@outstaff/core";
import type { ApiDocIssue, ApiIssueDoc, Itsaplan } from "@outstaff/integration.shared.itsaplan";

/**
 * Documents linked on issues: Its a Plan's explicit links between a Docs page and a work item, addressed by the
 * issue's internal id. A link that exists already is left as it is.
 */
export function issueLinkHelpers(api: Itsaplan, idOf: (idOrPath: string) => Promise<number>) {
  const docs = `${api.projectPath}/documents`;

  return {
    async linkIssue(docId: string, ticketKey: string): Promise<DocIssueLinkOutcome> {
      const [id, issue] = await Promise.all([idOf(docId), api.issue(ticketKey)]);
      const linked = await api.http.request<ApiDocIssue[]>("GET", `${docs}/${id}/issues`);
      if (linked.some((l) => l.issueId === issue.id)) {
        return "already_linked";
      }

      try {
        await api.http.request("POST", `${docs}/${id}/issues`, { body: { issueId: issue.id } });
      } catch (error) {
        // Linked meanwhile: the API refuses a second link.
        if (error instanceof PortError && error.code === "conflict") {
          return "already_linked";
        }

        throw error;
      }

      return "linked";
    },

    async issueDocs(ticketKey: string): Promise<IssueDoc[]> {
      const issue = await api.issue(ticketKey);
      const list = await api.http.request<ApiIssueDoc[]>("GET", `${docs}/for-issue/${issue.id}`);
      return list.map((d) => ({ id: String(d.documentId), title: d.title }));
    },
  };
}
