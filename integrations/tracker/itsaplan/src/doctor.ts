import type { DeriveContext, DoctorCheck, SecretSource } from "@outstaff/core";
import { Itsaplan } from "./client.js";
import { ItsaplanHttp } from "./http.js";
import { knowledgeOptions, resolveConnection } from "./options.js";

interface Me {
  id?: number | string;
  username?: string;
  user?: { id?: number | string; username?: string };
}

/** The member an API key belongs to. */
interface KeyOwner {
  id: number | string | undefined;
  username: string | undefined;
}

/** The member the API key belongs to, wherever this version of /me puts it. */
function memberOf(me: Me): KeyOwner {
  return { id: me.id ?? me.user?.id, username: me.username ?? me.user?.username };
}

async function connect(apiKey: string, ctx: DeriveContext): Promise<{ api: Itsaplan; me: Me }> {
  const conn = resolveConnection(ctx, knowledgeOptions.parse(ctx.options ?? {}));
  const http = new ItsaplanHttp({
    fetch: ctx.fetch,
    apiUrl: conn.api_url,
    webUrl: conn.url,
    apiKey,
  });

  const api = new Itsaplan(http, conn, ctx);
  return { api, me: await http.request<Me>("GET", "/me") };
}

function keyFailure(e: unknown): DoctorCheck {
  return {
    key: "ITSAPLAN_API_KEY",
    name: "Its a Plan API key",
    status: "fail",
    detail: `An authenticated call failed with ITSAPLAN_API_KEY: ${(e as Error).message}`,
    fix: "Create a new key under Account settings > API keys, signed in as that member, and check the url and api_url options.",
  };
}

function keyCheck(id: number | string | undefined): DoctorCheck {
  return {
    key: "ITSAPLAN_API_KEY",
    name: "Its a Plan API key",
    status: "ok",
    detail: `An authenticated call works${id === undefined ? "" : ` (member ${id})`}.`,
  };
}

/** Fails when a configured ITSAPLAN_MEMBER_ID is not the member the key belongs to. */
function memberIdCheck(
  configured: string | undefined,
  id: number | string | undefined,
): DoctorCheck | undefined {
  if (!configured || id === undefined || configured === String(id)) {
    return undefined;
  }

  return {
    key: "ITSAPLAN_MEMBER_ID",
    name: "Its a Plan member id",
    status: "fail",
    detail: `ITSAPLAN_MEMBER_ID is "${configured}" but the API key belongs to member ${id}.`,
    fix: "Remove ITSAPLAN_MEMBER_ID and run `ost setup --derive`, or use the key of the right member.",
  };
}

/** Compares a person's identities.tracker with the member the key belongs to. */
function compareIdentity(
  handle: string,
  wanted: string | undefined,
  { id, username }: KeyOwner,
): DoctorCheck {
  const name = "Its a Plan identity";
  if (!wanted) {
    return {
      name,
      status: "warn",
      detail: `identities.tracker is not set for ${handle}, so the office cannot recognise its activity.`,
      fix: `Set identities.tracker to ${id ?? "the member id"} for ${handle} in team.yaml.`,
    };
  }

  if (id === undefined) {
    return {
      name,
      status: "warn",
      detail: "Its a Plan did not return a member id, so identities.tracker cannot be compared.",
      fix: "Check the API key belongs to a member account.",
    };
  }

  if (wanted !== String(id) && wanted !== username) {
    return {
      name,
      status: "fail",
      detail: `identities.tracker is "${wanted}" but the API key belongs to member ${id}${username ? ` (${username})` : ""}.`,
      fix: `Set identities.tracker to ${id} for ${handle} in team.yaml, or use the key of the right member.`,
    };
  }

  return { name, status: "ok", detail: `identities.tracker matches member ${id}.` };
}

/** Only a person's own key has an identity to compare. */
function identityCheck(ctx: DeriveContext, member: KeyOwner): DoctorCheck | undefined {
  if (ctx.scope !== "person" || !ctx.person) {
    return undefined;
  }

  return compareIdentity(ctx.person.handle, ctx.person.identities?.tracker, member);
}

export async function doctorItsaplan(
  secrets: SecretSource,
  ctx: DeriveContext,
): Promise<DoctorCheck[]> {
  const apiKey = secrets.get("ITSAPLAN_API_KEY");
  if (!apiKey) {
    return [];
  }

  let session: { api: Itsaplan; me: Me };
  try {
    session = await connect(apiKey, ctx);
  } catch (e) {
    return [keyFailure(e)];
  }

  const member = memberOf(session.me);
  const checks = [
    keyCheck(member.id),
    await linkCheck(session.api),
    memberIdCheck(secrets.get("ITSAPLAN_MEMBER_ID"), member.id),
    identityCheck(ctx, member),
  ];

  return checks.filter((c) => c !== undefined);
}

/** Builds one issue link and one doc link so a human can click them; fails when the workspace is unknown. */
async function linkCheck(api: Itsaplan): Promise<DoctorCheck> {
  try {
    await api.loadWorkspace();
  } catch (e) {
    return {
      name: "Its a Plan links",
      status: "fail",
      detail: `The workspace of project ${api.conn.project} could not be determined: ${(e as Error).message}`,
      fix: "Check the project option and that the API key can read the project.",
    };
  }

  const key = `${api.conn.project.split(".").at(-1)}-1`;
  return {
    name: "Its a Plan links",
    status: "ok",
    detail: `Workspace ${api.workspace}. Issue link ${api.issueUrl(key)}, doc link ${api.docUrl("1")}. Open them to check.`,
  };
}
