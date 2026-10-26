import { describe, expect, it } from "vitest";
import { PortError } from "../errors.js";
import { parseRepoUrl } from "../repo.js";

describe("parseRepoUrl", () => {
  it.each([
    ["github.com/acme/shop", { host: "github.com", owner: "acme", name: "shop" }],
    ["https://github.com/acme/shop", { host: "github.com", owner: "acme", name: "shop" }],
    ["https://github.com/acme/shop.git", { host: "github.com", owner: "acme", name: "shop" }],
    ["https://user@GitHub.com/acme/shop/", { host: "github.com", owner: "acme", name: "shop" }],
    ["git@github.com:acme/shop.git", { host: "github.com", owner: "acme", name: "shop" }],
    [
      "ssh://git@git.acme.example:2222/acme/shop.git",
      { host: "git.acme.example", owner: "acme", name: "shop" },
    ],
    [
      "https://gitlab.example/acme/platform/shop",
      { host: "gitlab.example", owner: "acme/platform", name: "shop" },
    ],
  ])("parses %s", (url, expected) => {
    expect(parseRepoUrl(url)).toEqual(expected);
  });

  it.each(["", "shop", "github.com/shop", "https://github.com"])("rejects %j", (url) => {
    expect(() => parseRepoUrl(url)).toThrow(PortError);
  });
});
