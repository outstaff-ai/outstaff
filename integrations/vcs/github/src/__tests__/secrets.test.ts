import { silentLogger, type SecretSpec, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { githubOptions } from "#/options.js";
import { githubVcs } from "#/index.js";

const team = {
  team: { name: "acme" },
  repos: [
    { name: "shop", url: "github.com/acme-example/shop", kind: "primary" },
    { name: "docs", url: "github.com/acme-example/docs", kind: "other" },
  ],
  people: [],
} as unknown as TeamConfig;

const person = (repos: Record<string, string>) =>
  ({
    handle: "leo",
    name: "Leo",
    role: "designer",
    model: "sonnet",
    repos,
  }) as TeamConfig["people"][number];

const keys = (specs: SecretSpec[]) => specs.map((s) => s.key);
const own = (specs: SecretSpec[]) => specs.filter((s) => s.key.startsWith("GH_APP_"));
const office = (specs: SecretSpec[]) => specs.filter((s) => s.key.startsWith("GH_OFFICE_APP_"));

describe("github secrets by grants", () => {
  it("asks a person without grants for nothing", () => {
    expect(githubVcs.secrets("person", { team, person: person({}) })).toEqual([]);
  });

  it("asks a person whose grants name no repository of the team for nothing", () => {
    expect(githubVcs.secrets("person", { team, person: person({ "kind:infra": "read" }) })).toEqual(
      [],
    );
  });

  it("gives a reader the office App and an optional own App", () => {
    const specs = githubVcs.secrets("person", { team, person: person({ "*": "read" }) });
    expect(office(specs).length).toBeGreaterThan(0);
    expect(own(specs).length).toBeGreaterThan(0);
    expect(own(specs).every((s) => s.optional === true)).toBe(true);
    expect(office(specs).some((s) => s.optional !== true)).toBe(true);
  });

  it("requires a writer's own App", () => {
    const specs = githubVcs.secrets("person", {
      team,
      person: person({ "*": "read", docs: "write" }),
    });

    expect(
      own(specs)
        .filter((s) => s.optional !== true)
        .map((s) => s.key),
    ).toEqual(
      expect.arrayContaining(["GH_APP_ID", "GH_APP_PRIVATE_KEY", "GH_APP_INSTALLATION_ID"]),
    );
  });

  it("keeps the office scope as it was, whoever asks", () => {
    const specs = githubVcs.secrets("office");
    expect(keys(specs).every((k) => k.startsWith("GH_OFFICE_APP_"))).toBe(true);
    expect(githubVcs.secrets("office", { team, person: person({}) })).toEqual(specs);
  });

  it("lists every key without a person", () => {
    const specs = githubVcs.secrets("person");
    expect(own(specs).filter((s) => s.optional !== true).length).toBeGreaterThan(0);
    expect(office(specs).length).toBeGreaterThan(0);
  });

  it("is unavailable for a person without grants only", () => {
    expect(githubVcs.unavailableFor!({ team, person: person({}) })).toBe(
      "leo has no GitHub identity; ask a human or a teammate with repository access",
    );

    expect(githubVcs.unavailableFor!({ team, person: person({ shop: "read" }) })).toBeUndefined();
  });
});

describe("github adapter factory", () => {
  it("creates a VCS from the adapter context, with the default options", async () => {
    const vcs = await githubVcs.create({
      options: githubOptions.parse({}),
      secrets: { get: () => undefined, require: () => "x" },
      team,
      log: silentLogger,
      fetch: globalThis.fetch,
      now: () => new Date(),
    });

    expect(vcs.links.pr({ owner: "acme", name: "app" }, 3)).toBe(
      "https://github.com/acme/app/pull/3",
    );
  });
});
