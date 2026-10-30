import type { SecretSource, TeamConfig } from "@outstaff/core";

export const secretMap = (values: Record<string, string>): SecretSource => ({
  get: (k) => values[k],
  require(k) {
    const v = values[k];
    if (v === undefined) {
      throw new Error(`missing ${k}`);
    }

    return v;
  },
});

/** The acme team: sam is an agent (a people handle); rio is a human. */
export const team = {
  people: [{ handle: "sam" }],
  integrations: {
    tracker: { adapter: "itsaplan", url: "https://tracker.acme.example", project: "SHOP" },
  },
  workflow: {
    statuses: {
      backlog: "Backlog",
      ready: "Ready",
      active: "In Progress",
      review: "Review",
      blocked: "Blocked",
      done: "Done",
      canceled: "Canceled",
    },
  },
} as unknown as TeamConfig;
