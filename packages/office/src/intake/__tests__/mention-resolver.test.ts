import { PortError, type Member } from "@outstaff/core";
import { describe, expect, it, vi } from "vitest";
import { manualClock } from "#/clock.js";
import {
  createMentionResolver,
  DEFAULT_MEMBERS_TIMEOUT_MS,
  DEFAULT_MEMBERS_TTL_MS,
  normalizeName,
} from "#/intake/mentions.js";
import { teamConfig } from "./test-support.js";

const SAM: Member = { id: "u-sam", name: "Sam Duarte", username: "sam.duarte", kind: "agent" };

function resolverWith(members: () => Promise<Member[]>, extra: Record<string, unknown> = {}) {
  const clock = manualClock();
  const warn = vi.fn<(message: string, data?: Record<string, unknown>) => void>();
  const tracker = { members: vi.fn<() => Promise<Member[]>>(members) };
  const logger = { debug() {}, info() {}, warn, error() {} };
  const resolver = createMentionResolver({ team: teamConfig(extra), tracker, clock, logger });
  return { clock, warn, tracker, resolver };
}

describe("normalizeName", () => {
  it("drops case, spaces, dots, underscores and hyphens", () => {
    expect(
      ["sam.duarte", "Sam Duarte", "sam_duarte", "SAM-DUARTE", "samduarte"].map(normalizeName),
    ).toEqual(Array(5).fill("samduarte"));
  });
});

describe("createMentionResolver", () => {
  it("resolves the tracker username, the tracker identity, the handle and the name, exactly or normalised", async () => {
    const { resolver } = resolverWith(async () => [SAM]);
    const each = async (name: string) => resolver.resolve([name]);
    for (const name of [
      "sam.duarte",
      "SAM.DUARTE",
      "u-sam",
      "sam",
      "Sam",
      "Sam_Duarte",
      "samduarte",
    ]) {
      expect(await each(name)).toEqual(["sam"]);
    }

    expect(await each("Noor")).toEqual(["noor"]);
    expect(await each("sam.d")).toEqual([]);
  });

  it("keeps the order of the first mentions, without repeats, and ignores what is not a name", async () => {
    const { resolver } = resolverWith(async () => [SAM]);
    expect(await resolver.resolve(["noor", 7, "sam.duarte", "Sam", "nobody", "noor"])).toEqual([
      "noor",
      "sam",
    ]);

    expect(await resolver.resolve("sam")).toEqual([]);
    expect(await resolver.resolve([])).toEqual([]);
    expect(await resolver.resolve(undefined)).toEqual([]);
  });

  it("finds the member by username when the team file names it so", async () => {
    const { resolver } = resolverWith(async () => [{ ...SAM, username: "u-sam", name: "S. D." }]);
    expect(await resolver.resolve(["s.d"])).toEqual(["sam"]);
  });

  it("leaves a name two agents answer to unresolved, and warns of it", async () => {
    const { resolver, warn } = resolverWith(async () => [SAM], {
      people: [
        {
          handle: "sam",
          name: "Sam Duarte",
          role: "developer",
          model: "sonnet",
          identities: { tracker: "u-sam" },
        },
        { handle: "samd", name: "Sam D", role: "reviewer", model: "sonnet" },
        { handle: "sam-duarte", name: "Other", role: "reviewer", model: "sonnet" },
      ],
    });

    await resolver.load();
    expect(warn).toHaveBeenCalledWith(
      "intake: @samduarte could be any of sam, sam-duarte; a mention of it wakes no one",
      { name: "samduarte", handles: ["sam", "sam-duarte"] },
    );

    expect(await resolver.resolve(["Sam_Duarte", "samd", "sam.duarte"])).toEqual(["samd", "sam"]);
  });

  it("reads the members once, again once they are older than ten minutes, and keeps the last ones on a failure", async () => {
    let fail = false;
    const { resolver, tracker, clock, warn } = resolverWith(async () => {
      if (fail) {
        throw new PortError("unavailable", "down");
      }

      return [SAM];
    });

    expect(await resolver.resolve(["sam.duarte"])).toEqual(["sam"]);
    expect(await resolver.resolve(["sam.duarte"])).toEqual(["sam"]);
    expect(tracker.members).toHaveBeenCalledTimes(1);

    fail = true;
    clock.advance(DEFAULT_MEMBERS_TTL_MS);
    expect(await resolver.resolve(["sam.duarte"])).toEqual(["sam"]);
    expect(tracker.members).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "intake: the tracker's members could not be read; mentions match the team file",
      { error: "PortError: down" },
    );
  });

  it("gives up on a read that takes too long, matches the team file, and reads again on the next refresh", async () => {
    let answer = new Promise<Member[]>(() => {});
    const { resolver, tracker, clock, warn } = resolverWith(() => answer);
    const loading = resolver.load();
    clock.advance(DEFAULT_MEMBERS_TIMEOUT_MS);
    await loading;
    expect(warn).toHaveBeenCalledWith(
      "intake: the tracker's members could not be read; mentions match the team file",
      { error: `Error: no answer within ${DEFAULT_MEMBERS_TIMEOUT_MS} ms` },
    );

    expect(await resolver.resolve(["Sam", "sam.duarte"])).toEqual(["sam"]);
    expect(tracker.members).toHaveBeenCalledTimes(1);

    answer = Promise.resolve([SAM]);
    clock.advance(DEFAULT_MEMBERS_TTL_MS);
    expect(await resolver.resolve(["sam.duarte"])).toEqual(["sam"]);
    expect(tracker.members).toHaveBeenCalledTimes(2);
  });

  it("matches the team file alone without a tracker", async () => {
    const resolver = createMentionResolver({
      team: teamConfig(),
      clock: manualClock(),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    await resolver.load();
    expect(await resolver.resolve(["Sam", "sam.duarte"])).toEqual(["sam"]);
  });
});
