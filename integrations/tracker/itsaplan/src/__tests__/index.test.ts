import { silentLogger } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { itsaplanTracker } from "#/index.js";
import { API_KEY, createItsaplanFake, secretMap, team } from "@outstaff/testing.itsaplan";

describe("itsaplanTracker", () => {
  it("creates a tracker that talks to the configured instance with the member's key", async () => {
    const fake = createItsaplanFake();
    const tracker = await itsaplanTracker.create({
      options: itsaplanTracker.options.parse({
        url: "https://tracker.acme.example",
        project: "SHOP",
      }),
      secrets: secretMap({ ITSAPLAN_API_KEY: API_KEY }),
      team,
      log: silentLogger,
      fetch: fake.fetch,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const created = await tracker.createIssue({ title: "Plan the launch", body: "" });
    expect(created.url).toBe(`https://tracker.acme.example/acme/issue/${created.key}`);
    expect((await tracker.getIssue(created.key)).title).toBe("Plan the launch");
  });
});
