import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { clearAdapterOptions, validateAdapterOptions } from "../config/adapters.js";
import { parseTeamConfig } from "../config/parse.js";
import { validateTeam } from "../config/validate.js";
import { buildPolicy, evaluate } from "../permissions/index.js";
import { createFakeAdapterRegistry } from "../fakes/index.js";
import {
  AdapterRegistry,
  defineAdapter,
  PortError,
  envSecretSource,
  scrubEnv,
  splitAtLines,
} from "./index.js";

afterEach(() => clearAdapterOptions());

const team = (integrations: Record<string, unknown>) => {
  const r = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    humans: [{ name: "Alex", identities: { vcs: "alex" } }],
    catalog: { version: "1.0.0" },
    repos: [{ name: "app", url: "github.com/acme/app", kind: "primary" }],
    people: [{ handle: "ada", name: "Ada", role: "developer", repos: { app: "write" } }],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
      ...integrations,
    },
  });

  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config;
};

const def = () =>
  defineAdapter({
    port: "avatars",
    name: "thing",
    capabilities: ["avatars.generate"],
    options: z.strictObject({ style: z.enum(["pixel", "flat"]) }),
    secrets: () => [],
    create: () => ({
      render: async () => ({ data: new Uint8Array([1]), mime: "image/png" as const }),
    }),
  });

describe("AdapterRegistry.rulePacks", () => {
  const withRules = (name: string, scopes: string[]) =>
    defineAdapter({
      port: "avatars",
      name,
      capabilities: ["avatars.generate"],
      options: z.looseObject({}),
      secrets: () => [],
      create: () => ({
        render: async () => ({ data: new Uint8Array([1]), mime: "image/png" as const }),
      }),
      permissions: (scope) => {
        scopes.push(scope);
        return [{ id: `${name}.view`, program: name, effect: "allow", reason: "read-only" }];
      },
    });

  it("returns one adapter pack per adapter that defines permissions", () => {
    const scopes: string[] = [];
    const registry = new AdapterRegistry().register(withRules("alpha", scopes)).register(def());
    expect(registry.rulePacks()).toEqual([
      {
        id: "adapter.avatars.alpha",
        source: "adapter",
        rules: [{ id: "alpha.view", program: "alpha", effect: "allow", reason: "read-only" }],
      },
    ]);

    registry.rulePacks("office");
    expect(scopes).toEqual(["person", "office"]);
  });

  it("keeps only the adapters the team uses", () => {
    const registry = new AdapterRegistry()
      .register(withRules("alpha", []))
      .register(withRules("beta", []));

    const cfg = team({ avatars: { adapter: "beta" } });
    expect(registry.rulePacks("person", cfg).map((p) => p.id)).toEqual(["adapter.avatars.beta"]);
    expect(registry.rulePacks("person", team({})).map((p) => p.id)).toEqual([]);
  });

  it("feeds buildPolicy", () => {
    const registry = new AdapterRegistry().register(withRules("alpha", []));
    const policy = buildPolicy({
      profile: "code",
      person: { repos: {} },
      team: { repos: [] },
      layout: {
        home: "/h",
        workDir: "/w",
        reposDir: "/w/r",
        worktreesDir: "/w/t",
        scratchDir: "/w/s",
        memoryDir: "/w/m",
        secretsDir: "/w/x",
      },
      packs: registry.rulePacks(),
    });

    expect(evaluate(policy, { kind: "shell", command: "alpha x", cwd: "/w" }).rule).toBe(
      "alpha.view",
    );
  });
});

describe("AdapterRegistry", () => {
  it("registers, gets and lists by port; duplicates conflict", () => {
    const registry = new AdapterRegistry().register(def());
    expect(registry.get("avatars", "thing")?.name).toBe("thing");
    expect(registry.get("avatars", "other")).toBeUndefined();
    expect(registry.list("chat")).toEqual([]);
    expect(() => registry.register(def())).toThrow(PortError);
  });

  it("derives the validator's adapter map", () => {
    const map = new AdapterRegistry().register(def()).toValidationAdapters();
    expect(map.get("avatars/thing")).toEqual({
      port: "avatars",
      name: "thing",
      capabilities: ["avatars.generate"],
    });
  });

  it("feeds validateTeam: adapters in the registry are known, others are flagged", () => {
    const registry = createFakeAdapterRegistry();
    const ctx = { roles: new Map(), adapters: registry.toValidationAdapters() };
    expect(
      validateTeam(
        team({ vcs: { adapter: "fake" }, chat: { adapter: "fake" }, runtime: { adapter: "fake" } }),
        ctx,
      ).errors,
    ).toEqual([]);

    expect(
      validateTeam(
        team({
          vcs: { adapter: "github" },
          chat: { adapter: "fake" },
          runtime: { adapter: "fake" },
        }),
        ctx,
      ).errors,
    ).not.toEqual([]);
  });
});

describe("defineAdapter", () => {
  it("registers the option schema with the config validator", () => {
    def();
    expect(validateAdapterOptions(team({ avatars: { adapter: "thing", style: "pixel" } }))).toEqual(
      [],
    );

    expect(
      validateAdapterOptions(team({ avatars: { adapter: "thing", style: "cubist" } })).length,
    ).toBeGreaterThan(0);
  });
});

describe("envSecretSource", () => {
  const files: Record<string, string> = { "/run/secrets/outstaff/FROM_FILE": "filevalue\n" };
  const read = (p: string) => {
    if (p in files) {
      return files[p]!;
    }

    throw new Error("ENOENT");
  };

  it("prefers the secrets directory, falls back to the environment", () => {
    const s = envSecretSource(
      { FROM_ENV: "envvalue", FROM_FILE: "stale-env-value" },
      undefined,
      read,
    );

    expect(s.get("FROM_FILE")).toBe("filevalue");
    expect(s.get("FROM_ENV")).toBe("envvalue");
    expect(s.get("MISSING")).toBeUndefined();
    expect(() => s.require("MISSING")).toThrow(PortError);
  });

  it("reads the directory from OUTSTAFF_SECRETS_DIR", () => {
    const s = envSecretSource({ OUTSTAFF_SECRETS_DIR: "/custom" }, undefined, (p) => {
      if (p === "/custom/KEY") {
        return "v";
      }

      throw new Error("ENOENT");
    });

    expect(s.get("KEY")).toBe("v");
  });

  it("refuses keys that could escape the directory", () => {
    expect(() => envSecretSource({}, undefined, read).get("../etc/passwd")).toThrow(PortError);
  });
});

describe("scrubEnv", () => {
  it("drops secret keys and undefined values", () => {
    expect(
      scrubEnv({ PATH: "/bin", GH_APP_PRIVATE_KEY: "k", EMPTY: undefined }, ["GH_APP_PRIVATE_KEY"]),
    ).toEqual({ PATH: "/bin" });
  });
});

describe("splitAtLines", () => {
  it("keeps chunks within the limit and breaks at line ends", () => {
    expect(splitAtLines("aa\nbb\ncc", 5)).toEqual(["aa\nbb", "cc"]);
    expect(splitAtLines("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
    expect(splitAtLines("", 5)).toEqual([""]);
  });
});
