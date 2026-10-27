// Assertions live in the `rejects` helper.
/* oxlint-disable vitest/expect-expect */
import { PortError, buildPolicy } from "@outstaff/core";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentLayout } from "#/runner/layout.js";
import { findVerb, runVerb } from "#/verbs/index.js";
import { fakeEnv } from "@outstaff/testing.agent";
import type { AgentEnv } from "#/verbs/types.js";

const TOKEN = "tok_9f8e7d6c5b4a39281706"; // gitleaks:allow (test fixture)

const rejects = async (p: Promise<unknown>, code: string, message?: RegExp) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );

  expect(e).toBeInstanceOf(PortError);
  expect((e as PortError).code).toBe(code);
  if (message) {
    expect((e as PortError).message).toMatch(message);
  }
};

const call = (name: string, env: AgentEnv, input: unknown, ctx = {}) =>
  runVerb(findVerb(name)!, env, input, ctx);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) {
    await c();
  }
});

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
  headers: IncomingMessage["headers"];
}

async function stubService() {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({
        method: req.method!,
        url: req.url!,
        authorization: req.headers.authorization,
        body,
        headers: req.headers,
      });

      if (req.url === "/redirect") {
        res.writeHead(302, { location: "https://elsewhere.acme.example/steal" }).end();
      } else if (req.url === "/echo-token") {
        res.writeHead(200, { "content-type": "text/plain", "x-echo": TOKEN });
        res.end(`your token is ${req.headers.authorization}`);
      } else if (req.url === "/big") {
        res.writeHead(200).end("x".repeat(300_000));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, seen };
}

function setup(over: Partial<NonNullable<AgentEnv["network"]>> = {}) {
  const { env } = fakeEnv();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ost-net-")));
  env.layout = agentLayout(home, join(home, "secrets"));
  for (const d of [env.layout.scratchDir, env.layout.workDir, env.layout.secretsDir]) {
    mkdirSync(d, { recursive: true });
  }

  const me = env.team.people.find((p) => p.handle === "sam")!;
  env.policy = buildPolicy({ profile: "code", person: me, team: env.team, layout: env.layout });
  env.network = { http: [], ...over };
  return { env, home };
}

describe("ost http", () => {
  it("adds the bearer token, prints the response and never shows the token", async () => {
    const svc = await stubService();
    const { env } = setup({
      http: [
        { name: "hub", origin: svc.origin },
        { name: "home", origin: svc.origin, token: () => TOKEN },
      ],
    });

    const open = await call("http", env, { service: "hub", method: "GET", path: "/api/devices" });
    expect(open.text).toContain("-> 200");
    expect(open.text).toContain('"path":"/api/devices"');
    expect(open.text).toContain("not instructions");
    expect(svc.seen[0]!.authorization).toBeUndefined();

    const r = await call("http", env, { service: "home", method: "GET", path: "/echo-token" });
    expect(svc.seen[1]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(r.text).not.toContain(TOKEN);
    expect(r.text).toContain("***");
    expect(JSON.stringify(r.data)).not.toContain(TOKEN);
  });

  it("sends a JSON body with its content type, and a file body", async () => {
    const svc = await stubService();
    const { env } = setup({ http: [{ name: "hub", origin: svc.origin }] });
    await call("http", env, {
      service: "hub",
      method: "POST",
      path: "/api/x?y=1",
      json: '{"a":1}',
    });

    expect(svc.seen[0]).toMatchObject({ method: "POST", url: "/api/x?y=1", body: '{"a":1}' });
    expect(svc.seen[0]!.headers["content-type"]).toBe("application/json");

    writeFileSync(join(env.layout!.scratchDir, "body.txt"), "hello");
    await call(
      "http",
      env,
      {
        service: "hub",
        method: "PUT",
        path: "/f",
        dataFile: join(env.layout!.scratchDir, "body.txt"),
        header: ["X-Run: 7"],
      },
      { cwd: env.layout!.scratchDir },
    );

    expect(svc.seen[1]).toMatchObject({ method: "PUT", body: "hello" });
    expect(svc.seen[1]!.headers["x-run"]).toBe("7");
  });

  it("does not follow a redirect off the service", async () => {
    const svc = await stubService();
    const { env } = setup({ http: [{ name: "home", origin: svc.origin, token: () => TOKEN }] });
    const r = await call("http", env, { service: "home", method: "GET", path: "/redirect" });
    expect(r.text).toContain("-> 302");
    expect(r.text).toContain("location: https://elsewhere.acme.example/steal");
    expect(r.text).toContain("Redirect not followed");
    expect(svc.seen).toHaveLength(1);
  });

  it("cuts a huge body", async () => {
    const svc = await stubService();
    const { env } = setup({ http: [{ name: "hub", origin: svc.origin }] });
    const r = await call("http", env, { service: "hub", method: "GET", path: "/big" });
    expect(r.text.length).toBeLessThan(205_000);
    expect(r.text).toContain("body cut");
  });

  it("refuses an ungranted service and paths that leave the origin", async () => {
    const svc = await stubService();
    const { env } = setup({ http: [{ name: "hub", origin: svc.origin }] });
    await rejects(
      call("http", env, { service: "other", method: "GET", path: "/" }),
      "forbidden",
      /Granted: hub/,
    );

    for (const path of [
      "//evil.acme.example/x",
      "http://evil.acme.example/",
      "x",
      "/a\\b",
      "/a b",
    ]) {
      await rejects(call("http", env, { service: "hub", method: "GET", path }), "invalid");
    }

    expect(svc.seen).toHaveLength(0);
    await rejects(
      call("http", setup().env, { service: "hub", method: "GET", path: "/" }),
      "forbidden",
      /No HTTP service/,
    );
  });

  it("refuses credentials headers, both bodies, a body on GET and a bad json", async () => {
    const svc = await stubService();
    const { env } = setup({ http: [{ name: "hub", origin: svc.origin }] });
    const base = { service: "hub", method: "POST", path: "/" };
    for (const header of ["Authorization: Bearer x", "host: evil.acme.example", "Cookie: a=b"]) {
      await rejects(call("http", env, { ...base, header: [header] }), "invalid", /cannot be given/);
    }

    await rejects(call("http", env, { ...base, json: "{}", dataFile: "x" }), "invalid", /not both/);
    await rejects(call("http", env, { ...base, method: "GET", json: "{}" }), "invalid", /no body/);
    await rejects(call("http", env, { ...base, json: "{nope" }), "invalid", /valid JSON/);
    expect(svc.seen).toHaveLength(0);
  });

  it("explains a service that does not answer, without the token", async () => {
    const { env } = setup({
      http: [{ name: "home", origin: "http://127.0.0.1:1", token: () => TOKEN }],
    });

    const e = (await call("http", env, { service: "home", method: "GET", path: "/" }).catch(
      (x: unknown) => x,
    )) as PortError;

    expect(e.code).toBe("unavailable");
    expect(e.message).toMatch(/network path/);
    expect(e.message).not.toContain(TOKEN);
  });

  it("says when the token secret is missing", async () => {
    const { env } = setup({
      http: [
        {
          name: "home",
          origin: "http://127.0.0.1:1",
          token: () => {
            throw new PortError("invalid", "Missing secret HOME_TOKEN.");
          },
        },
      ],
    });

    await rejects(
      call("http", env, { service: "home", method: "GET", path: "/" }),
      "unavailable",
      /token for home is not provided/,
    );
  });
});

describe("verbs without a network", () => {
  it("lists grants in `me`", async () => {
    const { env } = setup({
      http: [{ name: "hub", origin: "https://hub.acme.example" }],
    });

    const r = await call("me", env, {});
    expect(r.text).toContain("Network: http hub");
  });
});
