import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, type DoctorCheck } from "@outstaff/core";
import { githubVcs } from "@outstaff/vcs-github";
import { describe, expect, it } from "vitest";
import { ACME_TEAM_FILE } from "../../core/src/testing/fixtures.js";
import { testKey } from "../../vcs-github/src/testing/keys.js";
import { createAgentAuth } from "../../office/src/protocol/auth.js";
import { createProtocolServer } from "../../office/src/protocol/server.js";
import { createFakeSource } from "../../office/src/protocol/testing.js";
import { systemClock } from "../../office/src/clock.js";
import type { AnyDef } from "./commands/setup-template.js";
import type { Context } from "./define.js";
import { run } from "./program.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ost-doctor-")));
let n = 0;

function project(edit: (team: string) => string = (t) => t) {
  const dir = join(root, `p${n++}`);
  mkdirSync(join(dir, ".outstaff"), { recursive: true });
  writeFileSync(join(dir, ".outstaff", "team.yaml"), edit(readFileSync(ACME_TEAM_FILE, "utf8")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function secretFiles(dir: string, files: Record<string, string>, mode = 0o600, scope = "mira") {
  const secrets = join(dir, ".outstaff", "secrets", scope);
  mkdirSync(secrets, { recursive: true });
  for (const [k, v] of Object.entries(files)) {
    writeFileSync(join(secrets, k), `${v}\n`);
    chmodSync(join(secrets, k), mode);
  }

  return secrets;
}

async function ost(cwd: string, args: string[], extra: Partial<Context> = {}) {
  let out = "";
  let err = "";
  const code = await run(args, {
    cwd,
    env: {},
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    gitOrigin: () => undefined,
    ...extra,
  });

  return { code, out, err };
}

const VALUE = "fake-value";

function fakeRegistry(doctor: (secret: string | undefined) => DoctorCheck[]) {
  const def = (port: string, name: string, withDoctor: boolean) =>
    ({
      port,
      name,
      capabilities: [],
      secrets: (scope: string) =>
        scope === "person" || port === "vcs"
          ? [
              { key: "FAKE_TOKEN", description: "d", where: "the console" },
              { key: "FAKE_ID", description: "d", where: "w", derivable: true },
              { key: "FAKE_OPT", description: "d", where: "w", optional: true },
            ]
          : [],
      ...(withDoctor
        ? {
            doctor: async (s: { get(k: string): string | undefined }) =>
              doctor(s.get("FAKE_TOKEN")),
          }
        : {}),
      create: () => ({}),
    }) as unknown as AnyDef;

  return new AdapterRegistry().register(def("vcs", "github", true));
}

describe("ost doctor", () => {
  it("reports a missing required secret with the fix, and exits 1", async () => {
    const dir = project();
    secretFiles(dir, { FAKE_TOKEN: VALUE });
    const r = await ost(dir, ["doctor", "mira"], { registry: fakeRegistry(() => []) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("fail  FAKE_ID present: FAKE_ID is not set");
    expect(r.out).toContain("Fix: Run `ost setup mira --derive`");
    expect(r.out).toContain("fail  OUTSTAFF_AGENT_TOKEN present");
    expect(r.out).not.toContain("FAKE_OPT");
    expect(r.out).toMatch(/ok, \d+ warnings, 2 failures\n$/);
  });

  it("checks no GitHub secrets for a person without repository grants", async () => {
    const dir = project();
    const registry = new AdapterRegistry().register(githubVcs as unknown as AnyDef);
    const env = { OUTSTAFF_AGENT_TOKEN: "fake-agent-token" };
    const fetchStub = (() => {
      throw new Error("no network expected");
    }) as unknown as typeof fetch;

    const r = await ost(dir, ["doctor", "leo", "--json"], { env, registry, fetch: fetchStub });
    const report = JSON.parse(r.out) as {
      scopes: { scope: string; checks: { name: string; status: string }[] }[];
    };

    const names = report.scopes.flatMap((s) => s.checks.map((c) => c.name));
    expect(names.some((name) => name.includes("GH_"))).toBe(false);
    expect(names).toContain("GitHub credentials");
    expect(report.scopes.flatMap((s) => s.checks).filter((c) => c.status === "fail")).toEqual([]);
  });

  it("takes secrets from the environment too", async () => {
    const dir = project();
    const env = { FAKE_TOKEN: VALUE, FAKE_ID: "1", OUTSTAFF_AGENT_TOKEN: "fake-agent-token" };
    const r = await ost(dir, ["doctor", "mira"], { env, registry: fakeRegistry(() => []) });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(VALUE);
  });

  it("fails on a secret file other users can read, and warns on other non-0600 modes", async () => {
    const dir = project();
    const env = { FAKE_ID: "1", OUTSTAFF_AGENT_TOKEN: "fake-agent-token" };
    const secrets = secretFiles(dir, { FAKE_TOKEN: VALUE }, 0o644);
    const r = await ost(dir, ["doctor", "mira"], { env, registry: fakeRegistry(() => []) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("fail  FAKE_TOKEN file mode");
    expect(r.out).toContain(`chmod 600 ${join(secrets, "FAKE_TOKEN")}`);

    chmodSync(join(secrets, "FAKE_TOKEN"), 0o400);
    const warn = await ost(dir, ["doctor", "mira"], { env, registry: fakeRegistry(() => []) });
    expect(warn.code).toBe(0);
    expect(warn.out).toContain("warn  FAKE_TOKEN file mode");
    expect(warn.out + warn.err).not.toContain(VALUE);
  });

  it("passes with 0600 files", async () => {
    const dir = project();
    secretFiles(dir, { FAKE_TOKEN: VALUE, FAKE_ID: "1", OUTSTAFF_AGENT_TOKEN: "fake-agent-token" });
    const r = await ost(dir, ["doctor", "mira"], { registry: fakeRegistry(() => []) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Secret file modes");
  });

  it("scrubs a secret value that a check carries by accident", async () => {
    const dir = project();
    secretFiles(dir, { FAKE_TOKEN: VALUE, FAKE_ID: "1", OUTSTAFF_AGENT_TOKEN: "fake-agent-token" });
    const registry = fakeRegistry((token) => [
      {
        name: "leaky",
        status: "fail",
        detail: `token ${token} was rejected`,
        fix: `use not ${token}`,
      },
    ]);

    const text = await ost(dir, ["doctor", "mira"], { registry });
    const json = await ost(dir, ["doctor", "mira", "--json"], { registry });
    expect(text.code).toBe(1);
    expect(text.out).toContain("token *** was rejected");
    expect(text.out + json.out + text.err).not.toContain(VALUE);
  });

  it("reports an adapter whose checks throw as a failure", async () => {
    const dir = project();
    secretFiles(dir, { FAKE_TOKEN: VALUE, FAKE_ID: "1", OUTSTAFF_AGENT_TOKEN: "fake-agent-token" });
    const registry = fakeRegistry(() => {
      throw new Error("boom");
    });

    const r = await ost(dir, ["doctor", "mira"], { registry });
    expect(r.code).toBe(1);
    expect(r.out).toContain("github checks: The checks could not run: boom");
  });

  it("checks the office and every person without a handle, as JSON", async () => {
    const dir = project();
    const r = await ost(dir, ["doctor", "--json"], { registry: fakeRegistry(() => []) });
    const body = JSON.parse(r.out) as {
      ok: boolean;
      summary: { fail: number };
      scopes: { scope: string }[];
    };

    expect(r.code).toBe(1);
    expect(body.ok).toBe(false);
    expect(body.scopes.map((s) => s.scope)).toEqual([
      "office",
      "priya",
      "tomas",
      "mira",
      "leo",
      "sam",
      "noor",
      "ines",
      "kofi",
    ]);
  });

  describe("tools", () => {
    // The versions of the developer toolset's tools, with the team's go.
    const VERSIONS: Record<string, string> = {
      go: "1.23.4",
      pnpm: "12.9.1",
      python: "3.13.9",
      yarn: "1.22.22",
    };

    const withTools = () => project((t) => `${t}\ntools:\n  go: { version: 1.23.4, allow: all }\n`);

    const env = { FAKE_TOKEN: VALUE, FAKE_ID: "1", OUTSTAFF_AGENT_TOKEN: "fake-agent-token" };

    it("passes when every declared tool resolves", async () => {
      const calls: string[][] = [];
      const r = await ost(withTools(), ["doctor", "mira"], {
        env,
        registry: fakeRegistry(() => []),
        home: root,
        mise: async (args) => {
          calls.push(args);
          return {
            code: 0,
            stdout: args[0] === "current" ? `${VERSIONS[args[1]!]}\n` : "",
            stderr: "",
          };
        },
      });

      expect(r.code).toBe(0);
      expect(r.out).toContain("ok    Tools resolve:");
      expect(r.out).toContain("go@1.23.4");
      expect(calls).toContainEqual(["current", "go"]);
    });

    it("names a tool that does not resolve: a failure in the agent container, a warning elsewhere", async () => {
      const mise = async (args: string[]) =>
        args[0] === "current" && args[1] === "go"
          ? { code: 0, stdout: "", stderr: "mise WARN Plugin go does not have a version set" }
          : { code: 0, stdout: `${VERSIONS[args[1]!]}\n`, stderr: "" };

      const here = await ost(withTools(), ["doctor", "mira"], {
        env,
        registry: fakeRegistry(() => []),
        home: root,
        mise,
      });

      expect(here.code).toBe(0);
      expect(here.out).toContain(
        "warn  Tool go resolves: go@1.23.4 does not resolve: no version is active",
      );

      const inside = await ost(
        withTools(),
        ["doctor", "mira", "--secrets-dir", "/run/secrets/outstaff"],
        {
          env,
          registry: fakeRegistry(() => []),
          home: root,
          mise,
        },
      );

      expect(inside.out).toContain("fail  Tool go resolves:");
    });

    it("says so when mise is not installed", async () => {
      const r = await ost(withTools(), ["doctor", "mira"], {
        env,
        registry: fakeRegistry(() => []),
        home: root,
        mise: async () => ({
          code: 127,
          stdout: "",
          stderr: "mise is not installed in this image.",
        }),
      });

      expect(r.out).toContain("warn  Tools resolve: mise is not installed here");
    });
  });

  it("rejects an unknown person and an invalid team", async () => {
    const dir = project();
    const unknown = await ost(dir, ["doctor", "nobody"], { registry: fakeRegistry(() => []) });
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('Unknown person "nobody"');

    writeFileSync(join(dir, ".outstaff", "team.yaml"), "version: 1\n");
    const bad = await ost(dir, ["doctor", "mira"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("error");
  });
});

describe("ost doctor with the shipped adapters", () => {
  const github = (id: string, slug: string, repos: string[], write: boolean) => ({
    app: { slug },
    installation: {
      account: { login: "acme-example" },
      repository_selection: "selected",
      permissions: {
        metadata: "read",
        contents: write ? "write" : "read",
        pull_requests: write ? "write" : "read",
        issues: write ? "write" : "read",
        checks: "read",
        statuses: "read",
      },
    },
    repos,
    id,
  });

  function router(opts: { officeWrites?: boolean; slackOk?: boolean } = {}) {
    const apps: Record<string, ReturnType<typeof github>> = {
      "11": github("11", "acme-mira", ["acme-example/shop"], true),
      "22": github(
        "22",
        "acme-office",
        ["shop", "infra", "design-system", "docs-site"].map((r) => `acme-example/${r}`),
        opts.officeWrites === true,
      ),
    };

    return (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (u.host === "slack.com") {
        const office =
          new Headers(init?.headers).get("authorization") === "Bearer xoxb-fake-office";

        return json(
          opts.slackOk === false
            ? { ok: false, error: "invalid_auth" }
            : { ok: true, user_id: office ? "U0OFFICE" : "U0MIRA005" },
        );
      }

      if (u.host === "api.tracker.acme.example") {
        return json({ id: 5, username: "mira.okafor" });
      }

      const bearer = String((init!.headers as Record<string, string>)["authorization"]).slice(7);
      const iss = bearer.startsWith("tok-")
        ? bearer.slice(4)
        : (JSON.parse(Buffer.from(bearer.split(".")[1]!, "base64url").toString()).iss as string);

      const a = apps[iss]!;
      if (u.pathname === "/app") {
        return json({ slug: a.app.slug });
      }

      if (u.pathname.endsWith("/access_tokens")) {
        return json({ token: `tok-${iss}` }, 201);
      }

      if (u.pathname === "/installation/repositories") {
        return json({ repositories: a.repos.map((full_name) => ({ full_name })) });
      }

      return json(a.installation);
    }) as typeof fetch;
  }

  const allSecrets = {
    OUTSTAFF_AGENT_TOKEN: "fake-agent-token",
    GH_APP_ID: "11",
    GH_APP_PRIVATE_KEY: testKey.privateKey,
    GH_APP_INSTALLATION_ID: "100",
    GH_APP_SLUG: "acme-mira",
    GH_OFFICE_APP_ID: "22",
    GH_OFFICE_APP_PRIVATE_KEY: testKey.privateKey,
    GH_OFFICE_APP_INSTALLATION_ID: "200",
    GH_OFFICE_APP_SLUG: "acme-office",
    SLACK_BOT_TOKEN: "xoxb-fake-bot",
    SLACK_APP_TOKEN: "xapp-fake-app",
    ITSAPLAN_API_KEY: "fake-itsaplan-key",
    ANTHROPIC_API_KEY: "fake-anthropic-key",
  };

  it("passes for a complete person, printing the derived value of each unset identity", async () => {
    const dir = project((t) =>
      t.replace("      chat: U0MIRA005\n      tracker: mira.okafor\n", ""),
    );

    secretFiles(dir, allSecrets);
    const r = await ost(dir, ["doctor", "mira"], { fetch: router(), now: () => new Date() });
    expect(r.out).not.toMatch(/^ {2}fail/m);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ok    GitHub App: repositories");
    expect(r.out).toContain("warn  Its a Plan identity");
    expect(r.out).toContain("warn  Slack identity");
    expect(r.out).toContain("Fix: Set identities.chat to U0MIRA005 for mira in team.yaml.");
    expect(r.out).toContain("Fix: Set identities.tracker to 5 for mira in team.yaml.");
    // Ids and slugs are public; every credential must stay out of the output.
    for (const [, v] of Object.entries(allSecrets).filter(([key]) => !/_ID$|SLUG/.test(key))) {
      expect(r.out + r.err).not.toContain(v);
    }
  });

  it("exits 1 when the office App can write and Slack rejects the token", async () => {
    const dir = project();
    secretFiles(dir, allSecrets);
    const r = await ost(dir, ["doctor", "mira"], {
      fetch: router({ officeWrites: true, slackOk: false }),
      now: () => new Date(),
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("fail  Office GitHub App: read-only");
    expect(r.out).toContain("Slack rejected SLACK_BOT_TOKEN: invalid_auth.");
    expect(r.out).toMatch(/2 failures\n$/);
  });

  it("checks the office with only its own secrets", async () => {
    const dir = project();
    const {
      SLACK_BOT_TOKEN: _a,
      SLACK_APP_TOKEN: _b,
      ANTHROPIC_API_KEY: _c,
      ...office
    } = allSecrets;

    secretFiles(
      dir,
      {
        ...office,
        SLACK_OFFICE_BOT_TOKEN: "xoxb-fake-office",
        ...Object.fromEntries(
          ["PRIYA", "TOMAS", "MIRA", "LEO", "SAM", "NOOR", "INES", "KOFI"].map((h) => [
            `OUTSTAFF_AGENT_TOKEN_${h}`,
            `${h}-token`,
          ]),
        ),
      },
      0o600,
      "office",
    );

    const r = await ost(dir, ["doctor", "office"], { fetch: router(), now: () => new Date() });
    expect(r.out).not.toMatch(/^ {2}fail/m);
    expect(r.out).toContain("Office GitHub App: read-only");
    expect(r.out).toContain("SLACK_OFFICE_BOT_TOKEN is valid for bot user U0OFFICE");
    expect(r.out).not.toContain("xoxb-fake-office");
    expect(r.code).toBe(0);
  });
});

describe("ost doctor office reachability", () => {
  const token = "fake-mira-token";
  const files = { OUTSTAFF_AGENT_TOKEN: token, FAKE_TOKEN: VALUE, FAKE_ID: "1" };
  const healthy = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

  async function office() {
    const server = createProtocolServer({
      source: createFakeSource([]),
      auth: createAgentAuth({ mira: token }),
      clock: systemClock,
      port: 0,
      host: "127.0.0.1",
    });

    await server.start();
    return { server, url: `ws://127.0.0.1:${server.port()}/agent` };
  }

  const doctor = (dir: string, env: Record<string, string>, fetch: typeof globalThis.fetch) =>
    ost(dir, ["doctor", "mira"], {
      env,
      fetch,
      officeTimeoutMs: 1500,
      registry: fakeRegistry(() => []),
    });

  it("passes when the health probe answers and the office accepts the token", async () => {
    const { server, url } = await office();
    try {
      const dir = project();
      secretFiles(dir, files);
      const r = await doctor(dir, { OUTSTAFF_OFFICE_URL: url }, healthy);
      expect(r.code).toBe(0);
      expect(r.out).toContain("ok    Office health");
      expect(r.out).toContain("ok    Office accepts the agent token");
      expect(r.out + r.err).not.toContain(token);
    } finally {
      await server.stop();
    }
  });

  it("fails when the office rejects the token, without printing it", async () => {
    const { server, url } = await office();
    try {
      const dir = project();
      secretFiles(dir, { ...files, OUTSTAFF_AGENT_TOKEN: "fake-other-token" });
      const r = await doctor(dir, { OUTSTAFF_OFFICE_URL: url }, healthy);
      expect(r.code).toBe(1);
      expect(r.out).toContain("office rejected the agent token for mira");
      expect(r.out + r.err).not.toContain("fake-other-token");
    } finally {
      await server.stop();
    }
  });

  it("fails when the office is unreachable", async () => {
    const dir = project();
    secretFiles(dir, files);
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const r = await doctor(dir, { OUTSTAFF_OFFICE_URL: "ws://127.0.0.1:9/agent" }, refused);
    expect(r.code).toBe(1);
    expect(r.out).toContain("office unreachable at ws://127.0.0.1:9/agent");
  });

  it("fails on a handshake that never completes when health answers", async () => {
    const dir = project();
    secretFiles(dir, files);
    const r = await doctor(dir, { OUTSTAFF_OFFICE_URL: "ws://127.0.0.1:9/agent" }, healthy);
    expect(r.code).toBe(1);
    expect(r.out).toContain("office unreachable at ws://127.0.0.1:9/agent");
  });

  it("warns and skips when no office URL is set, and warns about the office scope", async () => {
    const dir = project();
    secretFiles(dir, files);
    const r = await doctor(dir, {}, healthy);
    expect(r.out).toContain("warn  Office reachable: OUTSTAFF_OFFICE_URL is not set");
    const o = await ost(dir, ["doctor", "office"], { registry: fakeRegistry(() => []) });
    expect(o.out).toContain("warn  Office checks itself");
  });
});

describe("ost doctor secrets directory", () => {
  it("defaults to .outstaff/secrets/<handle> and works from a subdirectory of the repository", async () => {
    const dir = project();
    secretFiles(dir, { FAKE_TOKEN: VALUE });
    const sub = join(dir, "packages", "app");
    mkdirSync(sub, { recursive: true });
    const r = await ost(sub, ["doctor", "mira"], { registry: fakeRegistry(() => []) });
    expect(r.out).toContain(join(dir, ".outstaff", "secrets", "mira"));
    expect(r.out).not.toMatch(/FAKE_TOKEN is missing|Missing secret FAKE_TOKEN/);
  });

  it("lets --secrets-dir and OUTSTAFF_SECRETS_DIR override the default", async () => {
    const dir = project();
    const other = join(dir, "other");
    mkdirSync(other);
    writeFileSync(join(other, "FAKE_TOKEN"), `${VALUE}\n`, { mode: 0o600 });
    const registry = fakeRegistry(() => []);
    const flag = await ost(dir, ["doctor", "mira", "--secrets-dir", "other"], { registry });
    const env = await ost(dir, ["doctor", "mira"], {
      registry,
      env: { OUTSTAFF_SECRETS_DIR: other },
    });

    const none = await ost(dir, ["doctor", "mira"], { registry });
    expect(flag.out).toContain(other);
    expect(env.out).toContain(other);
    expect(none.out).not.toContain(other);
  });
});
