import { PortError } from "@outstaff/core";
import type { Vcs, VcsEvent } from "@outstaff/core";
import { afterEach, describe, expect, it } from "vitest";
import { REPO, setup } from "#/intake/test-support.js";

const delivery: VcsEvent = {
  externalId: "delivery-1",
  type: "pr.opened",
  repo: REPO,
  number: 7,
  actor: "acme-sam[bot]",
  at: "2030-01-01T00:00:00.000Z",
  data: {},
};

async function receiver() {
  const base = await setup({
    teamExtra: { office: { events: "webhook" } },
    webhook: { port: 0, host: "127.0.0.1" },
  });

  const vcs: Vcs = {
    ...base.vcs,
    async parseWebhook(headers, body) {
      if (headers["x-signature"] !== "valid") {
        throw new PortError("forbidden", "bad signature");
      }

      if (body === "garbage") {
        throw new PortError("invalid", "bad body");
      }

      return body === "ping" ? [] : [delivery];
    },
  };

  const ctx = await setup({
    store: base.store,
    ports: { vcs },
    teamExtra: { office: { events: "webhook" } },
    webhook: { port: 0, host: "127.0.0.1" },
  });

  await ctx.intake.start();
  const { host, port } = ctx.intake.address()!;
  const post = (path: string, body: string, signature = "valid") =>
    fetch(`http://${host}:${port}${path}`, {
      method: "POST",
      body,
      headers: { "x-signature": signature },
    });

  return { ...ctx, post, url: `http://${host}:${port}` };
}

let stop: (() => Promise<void>) | undefined;
afterEach(async () => stop?.());

describe("webhook receiver", () => {
  it("verifies via the adapter, normalizes and dedupes redeliveries", async () => {
    const r = await receiver();
    stop = () => r.intake.stop();
    expect((await r.post("/webhooks/vcs", "{}")).status).toBe(202);
    expect((await r.post("/webhooks/vcs", "{}")).status).toBe(202);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.event).toMatchObject({
      type: "pr.opened",
      subject: { pr: { number: 7 } },
      actor: { kind: "agent", id: "sam" },
    });

    expect((await r.post("/webhooks/vcs", "ping")).status).toBe(202);
    expect(r.events).toHaveLength(1);
  });

  it("rejects bad signatures, bad bodies, unknown sources and wrong methods", async () => {
    const r = await receiver();
    stop = () => r.intake.stop();
    expect((await r.post("/webhooks/vcs", "{}", "forged")).status).toBe(401);
    expect((await r.post("/webhooks/vcs", "garbage")).status).toBe(400);
    expect((await r.post("/webhooks/tracker", "{}")).status).toBe(404);
    expect((await r.post("/elsewhere", "{}")).status).toBe(404);
    expect((await fetch(`${r.url}/webhooks/vcs`)).status).toBe(405);
    expect((await r.post("/webhooks/vcs", "x".repeat(1_100_000))).status).toBe(413);
    expect(r.events).toHaveLength(0);
  });

  it("refuses to start in webhook mode when no adapter can parse webhooks", async () => {
    const { intake } = await setup({
      teamExtra: { office: { events: "webhook" } },
      webhook: { port: 0 },
    });

    await expect(intake.start()).rejects.toThrow(/parseWebhook/);
  });
});
