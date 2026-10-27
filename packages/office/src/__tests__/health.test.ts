import { afterEach, describe, expect, it } from "vitest";
import { createHealthServer } from "#/health.js";
import type { HealthServer } from "#/types.js";

describe("the health server", () => {
  let server: HealthServer;
  afterEach(() => server.stop());

  const start = async (office: Parameters<typeof createHealthServer>[0]) => {
    server = createHealthServer(office, 0, "127.0.0.1");
    await server.start();
    return `http://127.0.0.1:${server.port()}`;
  };

  it("has no doctor to ask without one, and answers 503 when the office cannot say", async () => {
    const base = await start({ health: () => Promise.reject(new Error("store gone")) });
    expect((await fetch(`${base}/doctor`)).status).toBe(404);
    const probe = await fetch(`${base}/healthz?verbose=1`);
    expect([probe.status, await probe.json()]).toEqual([503, { ok: false }]);
  });
});
