import { PortError, type DeriveContext, type DoctorCheck } from "@outstaff/core";
import type { ApiDocSummary, Itsaplan } from "@outstaff/integration.shared.itsaplan";

const NAME = "Its a Plan document links";
const NEEDS = "documents: edit and work items: edit";
const FIX = `Give the member ${NEEDS} in the project, which linking a document on a ticket needs.`;

/**
 * Whether an agent's key can work with the links between documents and tickets, so the documents it writes for a
 * ticket are linked on it. The API names no permissions of a key, and a link is a change, so the check reads the links
 * of a document and names what linking one needs; a key refused even that cannot link. The office's key only reads.
 */
export async function docLinkCheck(api: Itsaplan, ctx: DeriveContext): Promise<DoctorCheck[]> {
  if (ctx.scope !== "person") {
    return [];
  }

  try {
    const [doc] = await api.http.request<ApiDocSummary[]>("GET", `${api.projectPath}/documents`);
    if (!doc) {
      return [
        {
          name: NAME,
          status: "warn",
          detail: `Not checked: the project has no document yet. Linking one on a ticket needs ${NEEDS}.`,
          fix: "Run the doctor again once the project has a document.",
        },
      ];
    }

    await api.http.request("GET", `${api.projectPath}/documents/${doc.id}/issues`);
    return [
      {
        name: NAME,
        status: "ok",
        detail: `The key reads which tickets a document is linked on; linking one needs ${NEEDS}.`,
      },
    ];
  } catch (e) {
    const forbidden = e instanceof PortError && e.code === "forbidden";
    return [
      {
        name: NAME,
        status: "warn",
        detail: forbidden
          ? "The key may not read the links between documents and tickets, so the agent's documents are not linked on their tickets."
          : `Not checked: ${(e as Error).message}`,
        fix: FIX,
      },
    ];
  }
}
