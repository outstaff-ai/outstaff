import type { DeriveContext, DoctorCheck, SecretSource } from "@outstaff/core";
import {
  appTokenChecks,
  botUserIdChecks,
  filesScopeChecks,
  identityCheck,
} from "./doctor-checks.js";

type Person = NonNullable<DeriveContext["person"]>;

type AuthTest = {
  ok: boolean;
  user_id?: string;
  user?: string;
  error?: string;

  /** The scopes the token holds, from the `x-oauth-scopes` header. Absent when Slack did not say. */
  scopes?: string[];
};

async function authTest(token: string, ctx: DeriveContext): Promise<AuthTest | Error> {
  try {
    const res = await ctx.fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    const body = (await res.json()) as AuthTest;
    const scopes = res.headers?.get("x-oauth-scopes");
    return scopes ? { ...body, scopes: scopes.split(",").map((s) => s.trim()) } : body;
  } catch (e) {
    return e as Error;
  }
}

/** The office posts with its own post-only app; it must never hold an agent's token. */
async function doctorOfficeSlack(
  secrets: SecretSource,
  ctx: DeriveContext,
): Promise<DoctorCheck[]> {
  const key = "SLACK_OFFICE_BOT_TOKEN";
  const token = secrets.get(key);
  if (!token) {
    return [];
  }

  const body = await authTest(token, ctx);
  if (body instanceof Error) {
    return [
      {
        key,
        name: "Slack auth.test",
        status: "fail",
        detail: `Slack could not be reached: ${body.message}`,
        fix: "Check the network.",
      },
    ];
  }

  if (!body.ok || !body.user_id) {
    return [
      {
        key,
        name: "Slack auth.test",
        status: "fail",
        detail: `Slack rejected ${key}: ${body.error ?? "no user id returned"}.`,
        fix: "Copy the Bot User OAuth Token (xoxb-...) of the office app again; reinstall the app if it was revoked.",
      },
    ];
  }

  const bot = [body.user_id, body.user].filter(Boolean);
  const agent = ctx.team.people.find((p) => p.identities?.chat && bot.includes(p.identities.chat));
  if (agent) {
    return [
      {
        key,
        name: "Slack office app",
        status: "fail",
        detail: `${key} belongs to ${agent.handle}'s app (${body.user_id}), not the office's.`,
        fix: "Create the office's own app (`ost setup office`) and use its bot token.",
      },
    ];
  }

  return [
    {
      key,
      name: "Slack auth.test",
      status: "ok",
      detail: `${key} is valid for bot user ${body.user_id}.`,
    },
  ];
}

/** auth.test with the agent's bot token, then the checks that need its answer. */
async function botTokenChecks(
  token: string,
  secrets: SecretSource,
  person: Person,
  ctx: DeriveContext,
): Promise<DoctorCheck[]> {
  const body = await authTest(token, ctx);
  if (body instanceof Error) {
    return [
      {
        key: "SLACK_BOT_TOKEN",
        name: "Slack auth.test",
        status: "fail",
        detail: `Slack could not be reached: ${body.message}`,
        fix: "Check the network.",
      },
    ];
  }

  if (!body.ok || !body.user_id) {
    return [
      {
        key: "SLACK_BOT_TOKEN",
        name: "Slack auth.test",
        status: "fail",
        detail: `Slack rejected SLACK_BOT_TOKEN: ${body.error ?? "no user id returned"}.`,
        fix: "Copy the Bot User OAuth Token (xoxb-...) again from OAuth & Permissions; reinstall the app if it was revoked.",
      },
    ];
  }

  return [
    {
      key: "SLACK_BOT_TOKEN",
      name: "Slack auth.test",
      status: "ok",
      detail: `SLACK_BOT_TOKEN is valid for bot user ${body.user_id}.`,
    },
    ...filesScopeChecks(body.scopes),
    identityCheck(person.handle, person.identities?.chat, { id: body.user_id, name: body.user }),
    ...botUserIdChecks(secrets.get("SLACK_BOT_USER_ID"), body.user_id),
  ];
}

export async function doctorSlack(
  secrets: SecretSource,
  ctx: DeriveContext,
): Promise<DoctorCheck[]> {
  if (ctx.scope === "office") {
    return doctorOfficeSlack(secrets, ctx);
  }

  if (!ctx.person) {
    return [];
  }

  const out = appTokenChecks(secrets.get("SLACK_APP_TOKEN"));
  const token = secrets.get("SLACK_BOT_TOKEN");
  if (!token) {
    return out;
  }

  return [...out, ...(await botTokenChecks(token, secrets, ctx.person, ctx))];
}
