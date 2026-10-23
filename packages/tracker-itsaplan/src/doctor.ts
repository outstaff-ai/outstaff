import type { DeriveContext, DoctorCheck, SecretSource } from "@outstaff/core";
import { ItsaplanHttp } from "./http.js";
import { knowledgeOptions, resolveConnection } from "./options.js";

interface Me {
  id?: number | string;
  username?: string;
  user?: { id?: number | string; username?: string };
}

export async function doctorItsaplan(
  secrets: SecretSource,
  ctx: DeriveContext,
): Promise<DoctorCheck[]> {
  const apiKey = secrets.get("ITSAPLAN_API_KEY");
  if (!apiKey) {
    return [];
  }

  let me: Me;
  try {
    const conn = resolveConnection(ctx, knowledgeOptions.parse(ctx.options ?? {}));
    me = await new ItsaplanHttp({
      fetch: ctx.fetch,
      apiUrl: conn.api_url,
      webUrl: conn.url,
      apiKey,
    }).request<Me>("GET", "/me");
  } catch (e) {
    return [
      {
        key: "ITSAPLAN_API_KEY",
        name: "Its a Plan API key",
        status: "fail",
        detail: `An authenticated call failed with ITSAPLAN_API_KEY: ${(e as Error).message}`,
        fix: "Create a new key under Account settings > API keys, signed in as that member, and check the url and api_url options.",
      },
    ];
  }

  const id = me.id ?? me.user?.id;
  const username = me.username ?? me.user?.username;
  const out: DoctorCheck[] = [
    {
      key: "ITSAPLAN_API_KEY",
      name: "Its a Plan API key",
      status: "ok",
      detail: `An authenticated call works${id === undefined ? "" : ` (member ${id})`}.`,
    },
  ];

  const configured = secrets.get("ITSAPLAN_MEMBER_ID");
  if (configured && id !== undefined && configured !== String(id)) {
    out.push({
      key: "ITSAPLAN_MEMBER_ID",
      name: "Its a Plan member id",
      status: "fail",
      detail: `ITSAPLAN_MEMBER_ID is "${configured}" but the API key belongs to member ${id}.`,
      fix: "Remove ITSAPLAN_MEMBER_ID and run `ost setup --derive`, or use the key of the right member.",
    });
  }

  const wanted = ctx.person?.identities?.tracker;
  if (ctx.scope === "person" && ctx.person) {
    if (!wanted) {
      out.push({
        name: "Its a Plan identity",
        status: "warn",
        detail: `identities.tracker is not set for ${ctx.person.handle}, so the office cannot recognise its activity.`,
        fix: `Set identities.tracker to ${id ?? "the member id"} in the team file.`,
      });
    } else if (id === undefined) {
      out.push({
        name: "Its a Plan identity",
        status: "warn",
        detail: "Its a Plan did not return a member id, so identities.tracker cannot be compared.",
        fix: "Check the API key belongs to a member account.",
      });
    } else if (wanted !== String(id) && wanted !== username) {
      out.push({
        name: "Its a Plan identity",
        status: "fail",
        detail: `identities.tracker is "${wanted}" but the API key belongs to member ${id}${username ? ` (${username})` : ""}.`,
        fix: `Set identities.tracker to ${id} in the team file, or use the key of the right member.`,
      });
    } else {
      out.push({
        name: "Its a Plan identity",
        status: "ok",
        detail: `identities.tracker matches member ${id}.`,
      });
    }
  }

  return out;
}
