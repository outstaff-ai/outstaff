import { describe, expect, it } from "vitest";
import { trackerUsernameChecks } from "#/doctor/tracker-usernames.js";
import { PortError } from "#/ports/errors.js";
import type { Member } from "#/ports/tracker.js";

const team = {
  people: [
    { handle: "sam", identities: { tracker: "u-sam" } },
    { handle: "noor", identities: { tracker: "noor" } },
    { handle: "kofi", identities: { tracker: "u-kofi" } },
    { handle: "leo", identities: { tracker: "u-leo" } },
    { handle: "mira" },
  ],
} as never;

const members: Member[] = [
  { id: "u-sam", name: "Sam Duarte", username: "sam.duarte", kind: "agent" },
  { id: "u-noor", name: "Noor", username: "noor", kind: "agent" },
  { id: "u-kofi", name: "Kofi", kind: "agent" },
];

describe("trackerUsernameChecks", () => {
  it("says each agent's tracker username, and which agent has none", async () => {
    expect(await trackerUsernameChecks(team, { members: async () => members })).toEqual([
      {
        name: "Tracker username of sam",
        status: "ok",
        detail: "sam is @sam.duarte on the tracker.",
      },
      { name: "Tracker username of noor", status: "ok", detail: "noor is @noor on the tracker." },
      {
        name: "Tracker username of kofi",
        status: "warn",
        detail:
          "The tracker has no username for kofi (member u-kofi), so a mention of kofi by username is not recognised.",
        fix: "Give the member a username in the tracker, and set identities.tracker to the member's id or username.",
      },
      {
        name: "Tracker username of leo",
        status: "warn",
        detail:
          'No tracker member is "u-leo" (identities.tracker of leo), so a mention of leo by username is not recognised.',
        fix: "Give the member a username in the tracker, and set identities.tracker to the member's id or username.",
      },
    ]);
  });

  it("checks nothing without a tracker, or without an agent on it", async () => {
    expect(await trackerUsernameChecks(team, undefined)).toEqual([]);
    expect(
      await trackerUsernameChecks({ people: [{ handle: "mira" }] } as never, {
        members: async () => members,
      }),
    ).toEqual([]);
  });

  it("leaves the usernames not checked, saying why, when the members cannot be read", async () => {
    const tracker = { members: () => Promise.reject(new PortError("unavailable", "Down.")) };
    expect(await trackerUsernameChecks(team, tracker)).toEqual([
      {
        name: "Tracker usernames not checked",
        status: "warn",
        detail: "The tracker's members could not be read: Down.",
        fix: "Run the doctor again once that is fixed; until then, a mention of an agent by its tracker username may not be recognised.",
      },
    ]);
  });
});
