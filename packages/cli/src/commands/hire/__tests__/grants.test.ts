import { describe, expect, it } from "vitest";
import type { TeamConfig } from "@outstaff/core";
import { parseGrants } from "../grants.js";

const config = { repos: [{ name: "shop" }, { name: "infra" }] } as unknown as TeamConfig;

describe("parseGrants", () => {
  it("parses repo, kind and wildcard grants, skipping empty entries", () => {
    expect(parseGrants(" shop=write, ,kind:infra=read,*=read", config)).toEqual({
      shop: "write",
      "kind:infra": "read",
      "*": "read",
    });
  });

  it("rejects an entry that is not repo=read|write", () => {
    expect(parseGrants("shop=admin", config)).toBe('"shop=admin" is not repo=read or repo=write.');
    expect(parseGrants("shop=read=x", config)).toBe(
      '"shop=read=x" is not repo=read or repo=write.',
    );
  });

  it("rejects a repo the team does not have", () => {
    expect(parseGrants("web=read", config)).toBe(
      '"web" is not a repo of this team (repos: shop, infra), "kind:<kind>" or "*".',
    );
  });

  it("needs at least one grant", () => {
    expect(parseGrants(" , ", config)).toBe("Give at least one grant, for example *=read.");
  });
});
