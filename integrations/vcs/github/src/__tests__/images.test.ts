import { describe, expect, it } from "vitest";
import {
  OFFICE_APP,
  OWN_APP,
  build,
  expectPortError,
  REPO,
  type Route,
} from "@outstaff/testing.github";
import { createGithubStandIn } from "@outstaff/testing.github/stand-in";
import { testKey } from "@outstaff/testing.core";
import { githubOptions } from "#/options.js";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (fill: number) => ({
  name: "shot.png",
  mimetype: "image/png",
  data: new Uint8Array([...PNG, fill]),
});

// sam's container against the stand-in: its own App writes, the office App reads.
const secrets = {
  GH_OFFICE_APP_ID: String(OFFICE_APP),
  GH_OFFICE_APP_PRIVATE_KEY: testKey.privateKey,
  GH_APP_ID: String(OWN_APP),
  GH_APP_PRIVATE_KEY: testKey.privateKey,
  OUTSTAFF_PERSON: "sam",
};

function setup(options: Record<string, unknown> = {}, extra: Route[] = []) {
  const standIn = createGithubStandIn({ repo: REPO });
  const { vcs, stub } = build([...extra, ...standIn.routes], secrets, {}, undefined, {
    apiUrl: "https://api.github.test",
    webUrl: "https://github.example",
    ...options,
  });

  return { vcs, stub, store: standIn.store, dispatch: standIn.dispatch };
}

async function withPull(s: ReturnType<typeof setup>) {
  await s.store.backend.sha("feat/page");
  const opened = await s.vcs.openPullRequest(REPO, { head: "feat/page", title: "Page", body: "" });
  return opened.number;
}

describe("images on pull requests", () => {
  it("makes the assets branch an orphan with the first image, then commits on top of it", async () => {
    const s = setup();
    const number = await withPull(s);
    const first = await s.vcs.storeImage!(REPO, number, png(1));
    expect(first).toEqual({
      url: `https://github.example/acme/app/blob/outstaff-assets/${number}/shot.png?raw=true`,
      path: `${number}/shot.png`,
    });

    const head = s.store.git.refs.get("outstaff-assets")!;
    expect(s.store.git.commits.get(head)).toMatchObject({
      parents: [],
      message: `Image shot.png for pull request #${number}`,
    });

    await s.vcs.storeImage!(REPO, number, { ...png(2), name: "cart.png" });
    const next = s.store.git.refs.get("outstaff-assets")!;
    expect(s.store.git.commits.get(next)?.parents).toEqual([head]);
    expect(s.stub.called("PATCH", "/repos/acme/app/git/refs/heads/outstaff-assets")).toHaveLength(
      1,
    );

    expect(s.stub.called("POST", "/repos/acme/app/git/refs")).toHaveLength(1);
    // Nothing reached the repository the pull requests use.
    expect(Object.keys(await s.store.backend.branches())).not.toContain("outstaff-assets");
  });

  it("stores on the branch the options name, escaped in the link", async () => {
    const s = setup({ assetsBranch: "team/pr-images" });
    const number = await withPull(s);
    await s.vcs.storeImage!(REPO, number, png(1));
    const second = await s.vcs.storeImage!(REPO, number, { ...png(2), name: "my#shot.png" });
    expect(second.url).toBe(
      `https://github.example/acme/app/blob/team/pr-images/${number}/my-shot.png?raw=true`,
    );

    expect(s.store.git.refs.has("team/pr-images")).toBe(true);
  });

  it("writes nothing when the pull request is unknown, the file is refused or the branch cannot be read", async () => {
    const failing: Route = {
      method: "GET",
      path: "/repos/acme/app/git/ref/heads/outstaff-assets",
      handler: () => ({ status: 500, body: { message: "boom" } }),
    };

    const s = setup({}, [failing]);
    await expectPortError(s.vcs.storeImage!(REPO, 7, png(1)), "not_found");
    await expectPortError(
      s.vcs.storeImage!(REPO, 1, {
        name: "a.txt",
        mimetype: "text/plain",
        data: new Uint8Array(2),
      }),
      "invalid",
    );

    const number = await withPull(s);
    await expectPortError(s.vcs.storeImage!(REPO, number, png(1)), "unavailable");
    expect(s.store.git.blobs.size).toBe(0);
  });
});

describe("the assetsBranch option", () => {
  it("defaults to outstaff-assets and takes only a plain branch name", () => {
    expect(githubOptions.parse({}).assetsBranch).toBe("outstaff-assets");
    expect(githubOptions.parse({ assetsBranch: "assets/pr" }).assetsBranch).toBe("assets/pr");
    for (const bad of ["", "-x", "a..b", "a/", "a.lock", "a b", "a~1"]) {
      expect(githubOptions.safeParse({ assetsBranch: bad }).success).toBe(false);
    }
  });
});
