// Assertions live in the `rejects` helper.
/* oxlint-disable vitest/expect-expect */
import { PortError, buildPolicy } from "@outstaff/core";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentLayout } from "../../runner/layout.js";
import { adbRefusal } from "../adb.js";
import { findVerb, runVerb } from "../index.js";
import { fakeEnv } from "../testing.js";
import type { AgentEnv } from "../types.js";

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
  env.network = { http: [], adb: [], ...over };
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

/** An adb that logs its arguments and answers like a device would. */
function fakeAdb(dir: string) {
  const bin = join(dir, "adb");
  const log = join(dir, "adb.log");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "HOME=$HOME $*" >> "${log}"
case "$1" in
  pair) if [ "$3" = "111111" ]; then echo "Successfully paired to $2 [guid=adb-X]"; else echo "Failed: Wrong password"; fi ;;
  connect) case "$2" in *:40001) echo "connected to $2" ;; *:5555) echo "already connected to $2" ;; *) echo "failed to connect to '$2': Connection refused" ;; esac ;;
  -s) shift; shift; if [ "$1" = "shell" ] && [ "$2" = "sleep" ]; then sleep 5; fi; echo "ran: $*"; echo "token=abcdef0123456789abcdef" ;; # gitleaks:allow
  *) echo "unknown" >&2; exit 2 ;;
esac
`,
  );

  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

describe("ost adb", () => {
  const devices = [
    { name: "test-tablet", host: "10.0.0.16", pairing: "wireless" as const },
    { name: "wall-panel", host: "10.0.0.18", port: 5555 },
  ];

  function adbSetup() {
    const s = setup({ adb: devices });
    const fake = fakeAdb(s.home);
    s.env.network!.adbCommand = fake.bin;
    return { ...s, fake };
  }

  it("pairs with the port and code a human gave, as the agent's home, and hides the code", async () => {
    const { env, fake, home } = adbSetup();
    const r = await call("adb.pair", env, { device: "test-tablet", port: 37123, code: "111111" });
    expect(fake.calls()).toEqual([`HOME=${home} pair 10.0.0.16:37123 111111`]);
    expect(r.text).toContain("Paired with test-tablet");
    expect(r.text).toContain("ost adb connect test-tablet --port");
    expect(r.text).not.toContain("111111");
  });

  it("tells the agent to ask for a new code when pairing fails", async () => {
    const { env } = adbSetup();
    const e = (await call("adb.pair", env, {
      device: "test-tablet",
      port: 37123,
      code: "222222",
    }).catch((x: unknown) => x)) as PortError;

    expect(e.code).toBe("unavailable");
    expect(e.message).toMatch(/ask the human/);
    expect(e.message).not.toContain("222222");
  });

  it("needs a six-digit code and a wireless device", async () => {
    const { env } = adbSetup();
    await rejects(call("adb.pair", env, { device: "test-tablet", port: 1, code: "12" }), "invalid");

    await rejects(
      call("adb.pair", env, { device: "wall-panel", port: 1, code: "111111" }),
      "invalid",
      /needs no pairing/,
    );
  });

  it("connects, remembers the wireless port and asks for a new one when it stops answering", async () => {
    const { env, fake, home } = adbSetup();
    await rejects(
      call("adb.connect", env, { device: "test-tablet" }),
      "invalid",
      /Ask a human for the current port/,
    );

    const ok = await call("adb.connect", env, { device: "test-tablet", port: 40001 });
    expect(ok.text).toContain("Connected to test-tablet (10.0.0.16:40001)");
    expect(JSON.parse(readFileSync(join(home, ".outstaff", "adb-ports.json"), "utf8"))).toEqual({
      "test-tablet": { host: "10.0.0.16", port: 40001 },
    });

    // The remembered port is used without being given again.
    await call("adb.connect", env, { device: "test-tablet" });
    expect(fake.calls().at(-1)).toContain("connect 10.0.0.16:40001");

    // After a reboot the port changes: the old one is refused and the agent is told to ask.
    await rejects(
      call("adb.connect", env, { device: "test-tablet", port: 40999 }),
      "unavailable",
      /Wireless debugging[\s\S]*--port/,
    );

    // A failed connect does not replace the remembered port.
    await call("adb.connect", env, { device: "test-tablet" });
    expect(fake.calls().at(-1)).toContain("connect 10.0.0.16:40001");
  });

  it("connects a classic device on its fixed port and refuses another one", async () => {
    const { env } = adbSetup();
    const r = await call("adb.connect", env, { device: "wall-panel" });
    expect(r.text).toContain("10.0.0.18:5555");
    await rejects(
      call("adb.connect", env, { device: "wall-panel", port: 5556 }),
      "invalid",
      /granted on port 5555/,
    );
  });

  it("runs adb against that device only, after connecting, with masked output", async () => {
    const { env, fake } = adbSetup();
    const r = await call("adb.run", env, {
      device: "wall-panel",
      args: ["shell", "getprop", "ro.product.model"],
    });

    expect(fake.calls().map((c) => c.replace(/^HOME=\S+ /, ""))).toEqual([
      "connect 10.0.0.18:5555",
      "-s 10.0.0.18:5555 shell getprop ro.product.model",
    ]);

    expect(r.text).toContain("ran: shell getprop ro.product.model");
    expect(r.text).toContain("token=***");
    expect(r.text).not.toContain("abcdef0123456789abcdef");
    expect(r.text).toContain("exit: 0");
  });

  it("refuses to run on a wireless device whose port is unknown, an ungranted device and options that pick a device", async () => {
    const { env, fake } = adbSetup();
    await rejects(
      call("adb.run", env, { device: "test-tablet", args: ["devices"] }),
      "invalid",
      /Ask a human/,
    );

    await rejects(
      call("adb.run", env, { device: "other", args: ["devices"] }),
      "forbidden",
      /Granted/,
    );

    await rejects(
      call("adb.run", env, { device: "wall-panel", args: ["-s", "10.0.0.99:5555", "shell"] }),
      "forbidden",
      /device is chosen for you/,
    );

    expect(fake.calls().some((c) => c.includes("10.0.0.99"))).toBe(false);
  });

  it("stops a command that runs too long", async () => {
    const { env } = adbSetup();
    const r = await call("adb.run", env, {
      device: "wall-panel",
      args: ["shell", "sleep"],
      timeout: 1,
    });

    expect(r.text).toContain("Stopped after 1 seconds");
  });

  it("says so when adb is not installed", async () => {
    const { env } = setup({ adb: devices, adbCommand: "/nonexistent/adb" });
    await rejects(
      call("adb.connect", env, { device: "wall-panel" }),
      "unavailable",
      /adb is not installed/,
    );
  });

  it("is refused without grants", async () => {
    await rejects(call("adb.connect", setup().env, { device: "x" }), "forbidden", /No device/);
  });
});

describe("adb refusals", () => {
  it.each([
    [["connect", "10.0.0.5:5555"]],
    [["disconnect"]],
    [["tcpip", "5555"]],
    [["root"]],
    [["sideload", "x.zip"]],
    [["reboot", "bootloader"]],
    [["reboot", "recovery"]],
    [["shell", "recovery --wipe_data"]],
    [["shell", "am", "broadcast", "-a", "android.intent.action.MASTER_CLEAR"]],
    [["shell", "am broadcast -a android.intent.action.FACTORY_RESET"]],
    [["uninstall", "com.android.systemui"]],
    [["uninstall", "--user", "0", "com.acme.app"]],
    [["shell", "pm", "uninstall", "-k", "--user", "0", "com.google.android.gms"]],
    [["shell", "pm uninstall com.android.chrome"]],
    [["shell", "echo hi; pm disable-user com.android.settings"]],
    [["shell", "cmd package uninstall com.google.android.apps.x"]],
    [["shell", "pm", "clear", "com.google.android.gms"]],
    [["-s", "10.0.0.99:5555", "shell"]],
    [[]],
  ])("refuses %j", (args) => {
    expect(adbRefusal(args)).toBeDefined();
  });

  it.each([
    [["shell", "getprop", "ro.build.version.release"]],
    [["logcat", "-d", "-t", "100"]],
    [["install", "-r", "app-debug.apk"]],
    [["uninstall", "com.acme.app"]],
    [["shell", "pm", "clear", "com.acme.app"]],
    [["shell", "pm", "list", "packages"]],
    [["reboot"]],
    [["shell", "input", "tap", "10", "10"]],
    [["push", "a.txt", "/sdcard/"]],
  ])("allows %j", (args) => {
    expect(adbRefusal(args)).toBeUndefined();
  });
});

describe("verbs without a network", () => {
  it("lists grants in `me`", async () => {
    const { env } = setup({
      http: [{ name: "hub", origin: "https://hub.acme.example" }],
      adb: [{ name: "test-tablet", host: "10.0.0.16", pairing: "wireless" }],
    });

    const r = await call("me", env, {});
    expect(r.text).toContain("Network: http hub, adb test-tablet (wireless)");
  });
});
