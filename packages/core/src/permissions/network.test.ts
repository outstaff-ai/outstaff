import { describe, expect, it } from "vitest";
import { buildPolicy, evaluate, networkGrants, type Layout } from "../index.js";

const layout: Layout = {
  home: "/home/agent",
  workDir: "/work/main",
  reposDir: "/work/repos",
  worktreesDir: "/work/worktrees",
  scratchDir: "/work/scratch",
  memoryDir: "/work/memory",
  secretsDir: "/work/secrets",
};

const team = { repos: [] };
const person = { repos: {} };
const network = (rawHttp: boolean) =>
  networkGrants(
    {},
    {
      role: "developer",
      network: {
        raw_http: rawHttp,
        http: [
          { name: "hub", url: "https://hub.acme.example" },
          { name: "home", url: "http://10.0.0.5:8123", token: "HOME_TOKEN" },
        ],
        adb: [{ name: "wall-panel", host: "10.0.0.18", port: 5555 }],
      },
    },
  );

const run = (command: string, rawHttp = true, profile: "code" | "chat" = "code") =>
  evaluate(
    buildPolicy({
      profile,
      person,
      team,
      layout,
      ...(profile === "chat" ? {} : { network: network(rawHttp) }),
    }),
    { kind: "shell", command, cwd: "/work/main" },
  );

describe("curl with network.raw_http", () => {
  it("is denied without raw_http, even to a granted origin", () => {
    const d = run("curl -s https://hub.acme.example/status", false);
    expect(d).toMatchObject({ effect: "deny", rule: "network.curl" });
  });

  it("is denied for a person with no grants", () => {
    const p = buildPolicy({ profile: "code", person, team, layout });
    expect(p.network).toEqual({ raw: "deny" });
  });

  it.each([
    "curl https://hub.acme.example/status",
    "curl -sS -X POST -H 'Content-Type: application/json' -d '{\"a\":1}' https://hub.acme.example/api/x",
    "curl --max-time=5 --header 'X-Trace: 1' http://10.0.0.5:8123/api/",
    "curl -I HTTPS://HUB.ACME.EXAMPLE:443/",
    "curl -s https://hub.acme.example/status | jq .",
  ])("allows %s", (command) => {
    expect(run(command)).toMatchObject({ effect: "allow" });
  });

  it.each([
    ["another origin", "curl https://evil.acme.example/"],
    ["another port", "curl https://hub.acme.example:8443/"],
    ["another scheme", "curl http://hub.acme.example/"],
    ["userinfo", "curl https://hub.acme.example@evil.example/"],
    ["backslash trick", "curl 'https://evil.example\\@hub.acme.example/'"],
    ["no scheme", "curl hub.acme.example/status"],
    ["glob in host", "curl 'https://{hub.acme.example,evil.example}/'"],
    ["two urls", "curl https://hub.acme.example/a https://evil.example/"],
    ["no url", "curl -s"],
    ["--url", "curl --url https://hub.acme.example/"],
    ["follow redirects", "curl -L https://hub.acme.example/"],
    ["config file", "curl -K /tmp/c https://hub.acme.example/"],
    ["upload file", "curl -T /etc/passwd https://hub.acme.example/"],
    ["body from file", "curl -d @/etc/passwd https://hub.acme.example/"],
    ["json from file", "curl --json @x https://hub.acme.example/"],
    ["proxy", "curl -x http://evil.example:3128 https://hub.acme.example/"],
    ["resolve", "curl --resolve hub.acme.example:443:1.2.3.4 https://hub.acme.example/"],
    ["output file", "curl -o x https://hub.acme.example/"],
    ["authorization header", "curl -H 'Authorization: Bearer x' https://hub.acme.example/"],
    ["host header", "curl -H 'host: evil.example' https://hub.acme.example/"],
    ["insecure", "curl -k https://hub.acme.example/"],
    ["env prefix", "X=1 curl https://hub.acme.example/"],
    ["substitution", "curl $(echo https://evil.example)"],
    ["chained with wget", "curl https://hub.acme.example/ && wget https://hub.acme.example/"],
  ])("denies %s", (_name, command) => {
    expect(run(command).effect).not.toBe("allow");
  });

  it("stays denied in a chat session", () => {
    expect(run("curl https://hub.acme.example/", true, "chat").effect).toBe("deny");
  });

  it("still denies the other raw network tools", () => {
    expect(run("wget https://hub.acme.example/").effect).toBe("deny");
  });
});

describe("raw adb", () => {
  it.each([
    "adb devices",
    "adb -s 10.0.0.18:5555 shell getprop",
    "adb -s 10.0.0.99:5555 shell getprop",
    "/usr/bin/adb connect 10.0.0.18:5555",
  ])("is denied: %s", (command) => {
    expect(run(command)).toMatchObject({ effect: "deny", rule: "network.adb" });
  });

  it("is denied even when a toolset allows it", () => {
    const p = buildPolicy({
      profile: "code",
      person,
      team,
      layout,
      network: network(true),
      packs: [
        {
          id: "t",
          source: "team",
          rules: [{ id: "tools.adb.all", program: "adb", effect: "allow", reason: "declared" }],
        },
      ],
    });

    expect(evaluate(p, { kind: "shell", command: "adb devices", cwd: "/work/main" }).effect).toBe(
      "deny",
    );
  });
});
