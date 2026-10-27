import type { DeriveContext, SecretSource, SetupContext, SetupStep } from "@outstaff/core";
import { ItsaplanHttp } from "./http.js";
import { optionalConnectionOptions, resolveConnection } from "./options.js";

function address(ctx: SetupContext): string {
  const pattern = ctx.team.email?.pattern;
  if (pattern && ctx.person) {
    return `\`${pattern.replace("{handle}", ctx.person.handle)}\` (from \`email.pattern\` in the team file)`;
  }

  return ctx.person
    ? `an address you control, for example \`<you>+${ctx.person.handle}@<your domain>\` (plus-addressing on your own mailbox) or \`${ctx.person.handle}@agents.<your domain>\` forwarded to you (for example with Cloudflare Email Routing)`
    : "an address you control, for example `<you>+office@<your domain>`";
}

export function itsaplanSetupGuide(ctx: SetupContext): SetupStep[] {
  const who = ctx.person ? `${ctx.person.name}` : "the office";
  const username = ctx.person ? `\`${ctx.person.handle}\`` : "`office`";
  return [
    {
      title: `Give ${who} a member account`,
      body: `Its a Plan is invite-only, so one human step is needed once. Pick ${address(ctx)}. No mailbox is run by Outstaff. Invite that address to the team and to the project: Team settings > Members, then the project's members. The invite lands in a human's inbox.`,
    },
    {
      title: "A human accepts the invite",
      body: `Open the invite, accept it and finish the account (name, avatar). Use ${username} as the username${ctx.person ? ", so Outstaff recognises the member as an agent" : ""}. Give the member only the projects it works in, and let it read the project's activity feed (the dashboards permission), which the office uses to see events.`,
    },
    {
      title: "Create the API key",
      body: "Signed in as that member: Account settings > API keys > create. The key is shown once; keep it as `ITSAPLAN_API_KEY`. `ost setup --derive` then fills `ITSAPLAN_MEMBER_ID` from it.",
    },
  ];
}

export async function deriveItsaplan(
  secrets: SecretSource,
  ctx: DeriveContext,
): Promise<Record<string, string>> {
  const apiKey = secrets.get("ITSAPLAN_API_KEY");
  if (!apiKey || secrets.get("ITSAPLAN_MEMBER_ID")) {
    return {};
  }

  const conn = resolveConnection(ctx, optionalConnectionOptions.parse(ctx.options ?? {}));
  const http = new ItsaplanHttp({
    fetch: ctx.fetch,
    apiUrl: conn.api_url,
    webUrl: conn.url,
    apiKey,
  });

  const me = await http.request<{ id?: number | string; user?: { id?: number | string } }>(
    "GET",
    "/me",
  );

  const id = me.id ?? me.user?.id;
  if (id === undefined) {
    ctx.warn("Its a Plan /me did not return a member id.");
    return {};
  }

  return { ITSAPLAN_MEMBER_ID: String(id) };
}
