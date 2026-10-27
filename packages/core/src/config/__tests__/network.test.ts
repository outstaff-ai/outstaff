import { describe, expect, it } from "vitest";
import {
  CONFIG_CODES,
  grantTokenKeys,
  networkGrants,
  parseTeamConfig,
  validateTeam,
  type TeamConfigInput,
} from "#/index.js";

const base = (mutate: (c: any) => void = () => {}): TeamConfigInput => {
  const c: any = {
    version: 1,
    team: { name: "acme" },
    humans: [{ name: "Alex", identities: { vcs: "alex" } }],
    catalog: { version: "1.0.0" },
    repos: [{ name: "app", url: "github.com/acme/app", kind: "primary" }],
    people: [{ handle: "sam", name: "Sam", role: "developer", repos: { app: "write" } }],
    integrations: {
      chat: { adapter: "slack" },
      vcs: { adapter: "github" },
      runtime: { adapter: "claude-agent-sdk" },
    },
  };

  mutate(c);
  return c;
};

const codes = (input: TeamConfigInput) => {
  const r = parseTeamConfig(input);
  return r.ok ? [] : r.issues.map((i) => i.code);
};

describe("network grants in team.yaml", () => {
  it("accepts http grants on a person and a role", () => {
    const r = parseTeamConfig(
      base((c) => {
        c.roles = {
          developer: { network: { http: [{ name: "hub", url: "https://hub.acme.example" }] } },
        };

        c.people[0].network = {
          http: [{ name: "home", url: "https://home.acme.example:8123/", token: "HOME_TOKEN" }],
        };
      }),
    );

    expect(r.ok).toBe(true);
  });

  it.each([
    ["a path", "https://hub.acme.example/api"],
    ["credentials", "https://user:pw@hub.acme.example"],
    ["a query", "https://hub.acme.example/?a=1"],
    ["another scheme", "ftp://hub.acme.example"],
    ["no scheme", "hub.acme.example"],
  ])("rejects a service url with %s", (_n, url) => {
    expect(codes(base((c) => (c.people[0].network = { http: [{ name: "hub", url }] })))).toContain(
      CONFIG_CODES.networkInvalidUrl,
    );
  });

  it("rejects duplicate names and framework keys", () => {
    expect(
      codes(
        base(
          (c) =>
            (c.people[0].network = {
              http: [
                { name: "hub", url: "https://a.acme.example" },
                { name: "hub", url: "https://b.acme.example" },
              ],
            }),
        ),
      ),
    ).toContain(CONFIG_CODES.networkDuplicateName);

    expect(
      codes(
        base(
          (c) =>
            (c.people[0].network = {
              http: [{ name: "hub", url: "https://a.acme.example", token: "OUTSTAFF_AGENT_TOKEN" }],
            }),
        ),
      ),
    ).toContain(CONFIG_CODES.networkReservedToken);
  });

  it("says network.adb was removed and what replaces it, on a person and a role", () => {
    const r = parseTeamConfig(
      base((c) => {
        c.roles = { developer: { network: { adb: [{ name: "panel" }] } } };
        c.people[0].network = { adb: [{ name: "panel" }] };
      }),
    );

    const issues = r.ok ? [] : r.issues;
    expect(issues.map((i) => [i.path.join("."), i.code])).toEqual([
      ["people.0.network.adb", CONFIG_CODES.removedKey],
      ["roles.developer.network.adb", CONFIG_CODES.removedKey],
    ]);

    expect(issues[0]!.message).toMatch(/removed.*network policy.*under tools, with deny rules/);
  });

  it("still calls other unknown keys unknown", () => {
    const r = parseTeamConfig(base((c) => (c.people[0].network = { ssh: [] })));
    expect(r.ok ? [] : r.issues.map((i) => [i.code, i.message])).toEqual([
      [CONFIG_CODES.unknownKey, 'Unknown key "ssh".'],
    ]);
  });
});

describe("networkGrants", () => {
  const team = {
    roles: {
      developer: {
        network: {
          http: [
            { name: "hub", url: "https://hub.acme.example" },
            { name: "home", url: "https://home.acme.example", token: "ROLE_TOKEN" },
          ],
        },
      },
      qa: { network: { http: [{ name: "qa", url: "https://qa.acme.example" }] } },
    },
  };

  it("merges role, extended roles and the person, the later grant of a name winning", () => {
    const g = networkGrants(team, {
      role: "developer",
      extends: ["qa"],
      network: {
        http: [{ name: "home", url: "https://home.acme.example", token: "HOME_TOKEN" }],
      },
    });

    expect(g.http.map((h) => h.name).toSorted()).toEqual(["home", "hub", "qa"]);
    expect(g.http.find((h) => h.name === "home")?.token).toBe("HOME_TOKEN");
    expect(grantTokenKeys(g)).toEqual(["HOME_TOKEN"]);
  });

  it("gives a person with no grants nothing", () => {
    expect(networkGrants(team, { role: "architect" })).toEqual({ http: [] });
  });

  it("inherits from the role when the person has none", () => {
    expect(networkGrants(team, { role: "developer" }).http.map((a) => a.name)).toEqual([
      "hub",
      "home",
    ]);
  });
});

describe("validating network grants", () => {
  const ctx = (extra = {}) => ({
    roles: new Map([["developer", { needs: [] }]]),
    adapters: new Map(),
    ...extra,
  });

  const parsed = (mutate: (c: any) => void) => {
    const r = parseTeamConfig(base(mutate));
    if (!r.ok) {
      throw new Error(JSON.stringify(r.issues));
    }

    return r.config;
  };

  it("flags a roles entry that is not in the catalog", () => {
    const cfg = parsed((c) => (c.roles = { wizard: { network: {} } }));
    expect(validateTeam(cfg, ctx()).errors.map((e) => e.code)).toContain(
      CONFIG_CODES.rolesUnknownRole,
    );
  });

  it("flags a token that names a secret an integration reads", () => {
    const cfg = parsed(
      (c) =>
        (c.people[0].network = {
          http: [{ name: "home", url: "https://home.acme.example", token: "GH_APP_PRIVATE_KEY" }],
        }),
    );

    const errors = validateTeam(cfg, ctx({ secretKeys: new Set(["GH_APP_PRIVATE_KEY"]) })).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: CONFIG_CODES.networkReservedToken,
      path: ["people", 0, "network", "http", 0, "token"],
    });
  });
});
