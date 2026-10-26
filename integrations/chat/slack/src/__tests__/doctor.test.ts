import { envSecretSource, type DeriveContext, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { doctorSlack } from "../doctor.js";

const team = { team: { name: "acme" }, repos: [], people: [] } as unknown as TeamConfig;
const person = (chat?: string) =>
  ({ handle: "sam", name: "Sam", ...(chat ? { identities: { chat } } : {}) }) as never;

const ctx = (
  body: unknown,
  who = person("U0BOT"),
  scope: "person" | "office" = "person",
  headers: Record<string, string> = {},
) => {
  const calls: string[] = [];
  const c: DeriveContext = {
    team,
    scope,
    options: {},
    ...(scope === "person" ? { person: who } : {}),
    fetch: (async (url: string | URL) => {
      calls.push(String(url));
      if (body instanceof Error) {
        throw body;
      }

      return new Response(JSON.stringify(body), { status: 200, headers });
    }) as typeof fetch,
    now: () => new Date(),
    warn: () => {},
  };

  return { c, calls };
};

const secrets = (extra: Record<string, string> = {}) =>
  envSecretSource(
    { SLACK_BOT_TOKEN: "xoxb-fake-bot", SLACK_APP_TOKEN: "xapp-fake-app", ...extra },
    "/nonexistent",
  );

describe("doctorSlack", () => {
  it("passes when the token is valid and the ids match", async () => {
    const { c } = ctx({ ok: true, user_id: "U0BOT" });
    const checks = await doctorSlack(secrets({ SLACK_BOT_USER_ID: "U0BOT" }), c);
    expect(checks.map((x) => x.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("warns when the token lacks files:read, and says nothing when it has it or Slack does not list scopes", async () => {
    const missing = ctx({ ok: true, user_id: "U0BOT" }, person("U0BOT"), "person", {
      "x-oauth-scopes": "chat:write,im:history",
    });

    const checks = await doctorSlack(secrets(), missing.c);
    expect(checks.find((x) => x.name === "Slack files scope")).toMatchObject({
      key: "SLACK_BOT_TOKEN",
      status: "warn",
      fix: expect.stringContaining("files:read"),
    });

    const granted = ctx({ ok: true, user_id: "U0BOT" }, person("U0BOT"), "person", {
      "x-oauth-scopes": "chat:write, files:read",
    });

    expect(
      (await doctorSlack(secrets(), granted.c)).some((x) => x.name === "Slack files scope"),
    ).toBe(false);

    const unlisted = ctx({ ok: true, user_id: "U0BOT" });
    expect(
      (await doctorSlack(secrets(), unlisted.c)).some((x) => x.name === "Slack files scope"),
    ).toBe(false);
  });

  it("fails when auth.test rejects the bot token", async () => {
    const { c } = ctx({ ok: false, error: "invalid_auth" });
    const checks = await doctorSlack(secrets(), c);
    expect(checks.find((x) => x.key === "SLACK_BOT_TOKEN")).toMatchObject({
      status: "fail",
      detail: "Slack rejected SLACK_BOT_TOKEN: invalid_auth.",
    });
  });

  it("fails when identities.chat or SLACK_BOT_USER_ID names another user", async () => {
    const { c } = ctx({ ok: true, user_id: "U0BOT" }, person("U0OTHER"));
    const checks = await doctorSlack(secrets({ SLACK_BOT_USER_ID: "U0STALE" }), c);
    expect(checks.find((x) => x.name === "Slack identity")!.detail).toBe(
      'identities.chat is "U0OTHER" but the bot token belongs to U0BOT.',
    );

    expect(checks.find((x) => x.key === "SLACK_BOT_USER_ID")).toMatchObject({ status: "fail" });
  });

  it("warns when identities.chat is not set", async () => {
    const { c } = ctx({ ok: true, user_id: "U0BOT" }, person());
    expect(
      (await doctorSlack(secrets(), c)).find((x) => x.name === "Slack identity"),
    ).toMatchObject({
      status: "warn",
      fix: "Set identities.chat to U0BOT for sam in team.yaml.",
    });
  });

  it("fails on an app token that is not an app-level token", async () => {
    const { c } = ctx({ ok: true, user_id: "U0BOT" });
    const checks = await doctorSlack(secrets({ SLACK_APP_TOKEN: "xoxb-wrong" }), c);
    expect(checks.find((x) => x.key === "SLACK_APP_TOKEN")).toMatchObject({ status: "fail" });
    expect(JSON.stringify(checks)).not.toContain("xoxb-wrong");
  });

  it("fails when Slack is unreachable", async () => {
    const { c } = ctx(new Error("offline"));
    expect((await doctorSlack(secrets(), c)).at(-1)).toMatchObject({ status: "fail" });
  });

  it("ignores agent tokens for the office and makes no call without its own", async () => {
    const { c, calls } = ctx({ ok: true }, person(), "office");
    expect(await doctorSlack(secrets(), c)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("checks the office's own token, ignoring people without a chat identity", async () => {
    const { c } = ctx({ ok: true, user_id: "U0OFFICE" }, person(), "office");
    const checks = await doctorSlack(secrets({ SLACK_OFFICE_BOT_TOKEN: "xoxb-fake-office" }), {
      ...c,
      team: { ...team, people: [{ handle: "priya" }] } as unknown as TeamConfig,
    });

    expect(checks).toEqual([
      expect.objectContaining({ key: "SLACK_OFFICE_BOT_TOKEN", status: "ok" }),
    ]);
  });

  it("fails when the office token belongs to an agent's app", async () => {
    const withSam = {
      ...team,
      people: [{ handle: "priya" }, { handle: "sam", identities: { chat: "U0BOT" } }],
    };

    const { c } = ctx({ ok: true, user_id: "U0BOT" }, person(), "office");
    const checks = await doctorSlack(secrets({ SLACK_OFFICE_BOT_TOKEN: "xoxb-fake-office" }), {
      ...c,
      team: withSam as unknown as TeamConfig,
    });

    expect(checks).toEqual([
      expect.objectContaining({
        status: "fail",
        detail: "SLACK_OFFICE_BOT_TOKEN belongs to sam's app (U0BOT), not the office's.",
      }),
    ]);

    expect(JSON.stringify(checks)).not.toContain("xoxb-fake-office");
  });

  it("fails when Slack rejects the office token", async () => {
    const { c } = ctx({ ok: false, error: "invalid_auth" }, person(), "office");
    const checks = await doctorSlack(secrets({ SLACK_OFFICE_BOT_TOKEN: "xoxb-fake-office" }), c);
    expect(checks[0]).toMatchObject({
      status: "fail",
      detail: "Slack rejected SLACK_OFFICE_BOT_TOKEN: invalid_auth.",
    });
  });

  it("says nothing without a person, and without a bot token makes no call", async () => {
    const noPerson = ctx({ ok: true });
    delete (noPerson.c as { person?: unknown }).person;
    expect(await doctorSlack(secrets(), noPerson.c)).toEqual([]);
    expect(noPerson.calls).toEqual([]);

    const appOnly = ctx({ ok: true });
    const checks = await doctorSlack(
      envSecretSource({ SLACK_APP_TOKEN: "xapp-fake-app" }, "/nonexistent"),
      appOnly.c,
    );

    expect(checks.map((x) => [x.key, x.status])).toEqual([["SLACK_APP_TOKEN", "ok"]]);
    expect(appOnly.calls).toEqual([]);
  });

  it("does not check the app token when none is set", async () => {
    const { c } = ctx({ ok: true, user_id: "U0BOT" });
    const checks = await doctorSlack(
      envSecretSource({ SLACK_BOT_TOKEN: "xoxb-fake-bot" }, "/nonexistent"),
      c,
    );

    expect(checks.some((x) => x.key === "SLACK_APP_TOKEN")).toBe(false);
  });

  it("fails when auth.test answers ok without a bot user id", async () => {
    const { c } = ctx({ ok: true });
    expect((await doctorSlack(secrets(), c)).at(-1)).toMatchObject({
      status: "fail",
      detail: "Slack rejected SLACK_BOT_TOKEN: no user id returned.",
    });
  });

  it("fails when Slack is unreachable for the office token", async () => {
    const { c } = ctx(new Error("offline"), person(), "office");
    expect(await doctorSlack(secrets({ SLACK_OFFICE_BOT_TOKEN: "xoxb-fake-office" }), c)).toEqual([
      expect.objectContaining({
        key: "SLACK_OFFICE_BOT_TOKEN",
        status: "fail",
        detail: "Slack could not be reached: offline",
      }),
    ]);
  });

  it("fails when auth.test answers ok for the office token without a bot user id", async () => {
    const { c } = ctx({ ok: true }, person(), "office");
    const checks = await doctorSlack(secrets({ SLACK_OFFICE_BOT_TOKEN: "xoxb-fake-office" }), c);
    expect(checks[0]).toMatchObject({
      status: "fail",
      detail: "Slack rejected SLACK_OFFICE_BOT_TOKEN: no user id returned.",
    });
  });
});
