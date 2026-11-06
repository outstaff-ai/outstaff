import { describe, expect, it } from "vitest";
import { GH_VERSION, githubHostCli } from "#/host-cli.js";

const REPO = { host: "github.com", owner: "acme", name: "app" };
const QUIET = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
};

describe("githubHostCli", () => {
  it("declares gh, installed from mise's registry at a pinned version", () => {
    const cli = githubHostCli({ webUrl: "https://github.com" });
    expect(cli.command).toBe("gh");
    expect(cli.tool).toEqual({ version: GH_VERSION });
  });

  it("hands github.com its token as GH_TOKEN, with the repository", () => {
    expect(githubHostCli({ webUrl: "https://github.com" }).env("tok", REPO)).toEqual({
      ...QUIET,
      GH_TOKEN: "tok",
      GH_REPO: "acme/app",
    });
  });

  it("names the host of a ghe.com subdomain, which still reads GH_TOKEN", () => {
    const repo = { ...REPO, host: "acme.ghe.com" };
    expect(githubHostCli({ webUrl: "https://acme.ghe.com" }).env("tok", repo)).toEqual({
      ...QUIET,
      GH_TOKEN: "tok",
      GH_HOST: "acme.ghe.com",
      GH_REPO: "acme.ghe.com/acme/app",
    });
  });

  it("hands GitHub Enterprise Server its token as GH_ENTERPRISE_TOKEN", () => {
    const repo = { ...REPO, host: "github.acme.example" };
    expect(githubHostCli({ webUrl: "https://GitHub.acme.example/" }).env("tok", repo)).toEqual({
      ...QUIET,
      GH_ENTERPRISE_TOKEN: "tok",
      GH_HOST: "github.acme.example",
      GH_REPO: "github.acme.example/acme/app",
    });
  });
});
