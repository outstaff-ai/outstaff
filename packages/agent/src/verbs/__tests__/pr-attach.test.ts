import { PortError, buildPolicy } from "@outstaff/core";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findVerb, runVerb } from "#/verbs/index.js";
import { agentLayout } from "#/runner/layout.js";
import { fakeEnv } from "@outstaff/testing.agent";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function setup(level: "write" | "read" = "write") {
  const f = fakeEnv();
  const repo = f.vcs.seed.repo;
  f.env.team.repos[0]!.url = `${repo.host}/${repo.owner}/${repo.name}`;
  await f.vcs.seed.permission(repo, "sam", level);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ost-pr-attach-")));
  const layout = agentLayout(root, join(root, "secrets"));
  const dir = join(layout.worktreesDir, "shop");
  const scratch = join(layout.scratchDir, "w1");
  for (const d of [dir, scratch, layout.secretsDir]) {
    mkdirSync(d, { recursive: true });
  }

  f.env.layout = layout;
  f.env.policy = buildPolicy({
    profile: "code",
    person: f.env.team.people.find((p) => p.handle === "sam")!,
    team: f.env.team,
    layout,
  });

  execFileSync("git", ["init", "-q", "-b", "feat/cart"], { cwd: dir });
  execFileSync(
    "git",
    ["remote", "add", "origin", `https://${repo.host}/${repo.owner}/${repo.name}.git`],
    {
      cwd: dir,
    },
  );

  const pr = await f.vcs.seed.pullRequest(repo, { title: "Cart page" });
  const file = (name: string, bytes: number[]) => {
    writeFileSync(join(scratch, name), new Uint8Array(bytes));
    return join(scratch, name);
  };

  return { ...f, repo, pr, file, layout, ctx: { cwd: dir, workItemId: "w1" } };
}

const attach = (f: Awaited<ReturnType<typeof setup>>, input: Record<string, unknown>) =>
  runVerb(findVerb("pr.attach")!, f.env, { number: f.pr.number, ...input }, f.ctx);

const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );

  expect(e).toBeInstanceOf(PortError);
  return e as PortError;
};

describe("pr attach", () => {
  it("stores the image for the worktree's pull request and prints the markdown that shows it", async () => {
    const f = await setup();
    const r = await attach(f, { path: f.file("cart-empty.png", PNG) });
    const url = `${f.vcs.links.pr(f.repo, f.pr.number)}/images/cart-empty.png`;
    expect(r.text).toContain(
      `Stored cart-empty.png for acme/app#${f.pr.number} at ${f.pr.number}/cart-empty.png.`,
    );

    expect(r.text).toContain(`![cart-empty.png](${url})`);
    expect(r.links).toEqual([f.vcs.links.pr(f.repo, f.pr.number)]);
    expect(r.data).toEqual({
      markdown: `![cart-empty.png](${url})`,
      url,
      path: `${f.pr.number}/cart-empty.png`,
    });

    expect([
      ...f.vcs.images.get(`${f.vcs.seed.repo.host}/acme/app/${f.pr.number}/cart-empty.png`)!.data,
    ]).toEqual(PNG);
  });

  it("stores a downloaded file under its own name", async () => {
    const f = await setup();
    const path = f.file("1-screen.png", PNG);
    f.env.ticketFiles = {
      "SHOP-1": [{ name: "screen.png", mimetype: "image/png", size: 8, path }],
    };

    const r = await attach(f, { path });
    expect((r.data as { path: string }).path).toBe(`${f.pr.number}/screen.png`);
    f.env.ticketFiles = {};
    f.env.attachments = [{ name: "chat.png", mimetype: "image/png", size: 8, path }];
    expect(((await attach(f, { path })).data as { path: string }).path).toBe(
      `${f.pr.number}/chat.png`,
    );
  });

  it("takes alt text, made safe for markdown, and a repository by name", async () => {
    const f = await setup();
    const r = await attach(f, {
      repo: "shop",
      path: f.file("cart.png", PNG),
      alt: "Cart [with]\ncoupon",
    });

    expect((r.data as { markdown: string }).markdown).toMatch(/^!\[Cart  with  coupon\]\(/);
  });

  it("refuses where the code host stores no images, without a write grant, and a file that is not an image", async () => {
    const f = await setup("read");
    const shot = f.file("cart.png", PNG);
    expect((await refusal(attach(f, { path: shot }))).code).toBe("forbidden");
    expect(f.vcs.images.size).toBe(0);

    const g = await setup();
    const text = g.file("notes.png", [104, 105]);
    expect((await refusal(attach(g, { path: text }))).code).toBe("invalid");

    delete (g.vcs as { storeImage?: unknown }).storeImage;
    const none = await refusal(attach(g, { path: g.file("cart.png", PNG) }));
    expect(none.code).toBe("unsupported");
    expect(none.message).toMatch(/ost ticket attach/);
  });

  it("refuses a file outside the worktree and the scratch directory", async () => {
    const f = await setup();
    const secret = join(f.layout.secretsDir, "KEY.png");
    writeFileSync(secret, new Uint8Array(PNG));
    expect((await refusal(attach(f, { path: secret }))).message).toMatch(/outside the worktree/);
  });
});
