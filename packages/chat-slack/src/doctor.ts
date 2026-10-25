import type { DeriveContext, DoctorCheck, SecretSource } from "@outstaff/core";

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

  const out: DoctorCheck[] = [];
  const appToken = secrets.get("SLACK_APP_TOKEN");
  if (appToken) {
    out.push(
      appToken.startsWith("xapp-")
        ? {
            key: "SLACK_APP_TOKEN",
            name: "Slack app token",
            status: "ok",
            detail: "SLACK_APP_TOKEN is set, so Socket Mode can connect.",
          }
        : {
            key: "SLACK_APP_TOKEN",
            name: "Slack app token",
            status: "fail",
            detail:
              "SLACK_APP_TOKEN does not start with xapp-; it looks like a bot token or a copy mistake.",
            fix: "Use the app-level token with connections:write from Basic Information > App-Level Tokens.",
          },
    );
  }

  const token = secrets.get("SLACK_BOT_TOKEN");
  if (!token) {
    return out;
  }

  const body = await authTest(token, ctx);
  if (body instanceof Error) {
    return [
      ...out,
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
      ...out,
      {
        key: "SLACK_BOT_TOKEN",
        name: "Slack auth.test",
        status: "fail",
        detail: `Slack rejected SLACK_BOT_TOKEN: ${body.error ?? "no user id returned"}.`,
        fix: "Copy the Bot User OAuth Token (xoxb-...) again from OAuth & Permissions; reinstall the app if it was revoked.",
      },
    ];
  }

  out.push({
    key: "SLACK_BOT_TOKEN",
    name: "Slack auth.test",
    status: "ok",
    detail: `SLACK_BOT_TOKEN is valid for bot user ${body.user_id}.`,
  });

  // Without files:read the bot cannot download what people send; chat itself keeps working.
  if (body.scopes && !body.scopes.includes("files:read")) {
    out.push({
      key: "SLACK_BOT_TOKEN",
      name: "Slack files scope",
      status: "warn",
      detail:
        "The bot token lacks the files:read scope, so the agent cannot read pictures and files people send it; it only sees their names.",
      fix: "Add files:read under OAuth & Permissions > Bot Token Scopes, then reinstall the app and copy the new bot token.",
    });
  }

  const wanted = ctx.person.identities?.chat;
  if (!wanted) {
    out.push({
      name: "Slack identity",
      status: "warn",
      detail: `identities.chat is not set for ${ctx.person.handle}, so the office cannot recognise its messages.`,
      fix: `Set identities.chat to ${body.user_id} for ${ctx.person.handle} in team.yaml.`,
    });
  } else if (wanted !== body.user_id && wanted !== body.user) {
    out.push({
      name: "Slack identity",
      status: "fail",
      detail: `identities.chat is "${wanted}" but the bot token belongs to ${body.user_id}.`,
      fix: `Set identities.chat to ${body.user_id} for ${ctx.person.handle} in team.yaml, or use the token of the right app.`,
    });
  } else {
    out.push({
      name: "Slack identity",
      status: "ok",
      detail: `identities.chat matches ${body.user_id}.`,
    });
  }

  const configured = secrets.get("SLACK_BOT_USER_ID");
  if (configured && configured !== body.user_id) {
    out.push({
      key: "SLACK_BOT_USER_ID",
      name: "Slack bot user id",
      status: "fail",
      detail: `SLACK_BOT_USER_ID is "${configured}" but the bot token belongs to ${body.user_id}.`,
      fix: "Run `ost setup --derive` after removing the old value, or set it to the id above.",
    });
  }

  return out;
}
