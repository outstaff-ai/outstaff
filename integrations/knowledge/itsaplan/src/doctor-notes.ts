import { PortError, type DeriveContext, type DoctorCheck } from "@outstaff/core";
import type { ApiDocSummary, Itsaplan } from "@outstaff/integration.shared.itsaplan";
import { NOTES_ROOT } from "./notes.js";

const NAME = "Its a Plan agent notes";

/**
 * With `memory.store: knowledge`, whether the agent's key can read the project's documents, where its notes page is,
 * and whether that page is public, so humans can review it. Creating the page is a change, so the first start makes
 * it; the check only says so.
 */
export async function notesCheck(api: Itsaplan, ctx: DeriveContext): Promise<DoctorCheck[]> {
  const name = ctx.scope === "person" && ctx.team.memory?.store === "knowledge" && ctx.person?.name;
  if (!name) {
    return [];
  }

  try {
    return [pageCheck(name, await pageOf(api, name))];
  } catch (e) {
    return [refused(e)];
  }
}

/** The agent's notes page, as the key sees the project's documents. */
async function pageOf(api: Itsaplan, name: string): Promise<ApiDocSummary | undefined> {
  const all = await api.http.request<ApiDocSummary[]>("GET", `${api.projectPath}/documents`);
  const root = all.find((d) => d.title === NOTES_ROOT && !d.parentId);
  return root && all.find((d) => d.parentId === root.id && d.title === name);
}

function refused(e: unknown): DoctorCheck {
  const forbidden = e instanceof PortError && e.code === "forbidden";
  return {
    name: NAME,
    status: "fail",
    detail: forbidden
      ? "The key may not read the project's documents, so the agent cannot keep its notes there."
      : `Not checked: ${(e as Error).message}`,
    fix: "Give the member documents: edit in the project, or set memory.store: volume.",
  };
}

function pageCheck(name: string, page: ApiDocSummary | undefined): DoctorCheck {
  if (!page) {
    return {
      name: NAME,
      status: "ok",
      detail: `No page ${NOTES_ROOT}/${name} yet: the agent creates it on its first start, which needs documents: edit.`,
    };
  }

  return page.isPrivate
    ? {
        name: NAME,
        status: "warn",
        detail: `${NOTES_ROOT}/${name} is private, so no human can review the agent's notes.`,
        fix: "Make the page public in Its a Plan.",
      }
    : { name: NAME, status: "ok", detail: `The agent's notes are on ${NOTES_ROOT}/${name}.` };
}
