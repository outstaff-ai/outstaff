import { describe, expect, it } from "vitest";
import { formatWorkGroups, groupWork } from "../work-groups.js";
import type { WorkSummary } from "../types.js";

const url = (key: string) => `https://tracker.acme.example/issue/${key}`;
const PR = "https://git.acme.example/acme/app/pull/12";

const ticket: WorkSummary = {
  id: "w1",
  title: "ACME-43 core.pubsub",
  status: "queued",
  kind: "assigned",
  ticketKey: "ACME-43",
  ticketTitle: "core.pubsub for events and RPC",
};

const review: WorkSummary = {
  id: "w2",
  title: "review feedback: PR #12 feat(core): add core.pubsub (ACME-43)",
  status: "active",
  kind: "review_feedback",
  ticketKey: "ACME-43",
  ticketTitle: "core.pubsub for events and RPC",
  pr: "app#12",
  prNumber: 12,
  prTitle: "feat(core): add core.pubsub (ACME-43)",
  prUrl: PR,
};

describe("work groups", () => {
  it("shows a review round on a ticket's pull request as one line of that ticket", () => {
    const groups = groupWork([review]);
    expect(formatWorkGroups(groups, url)).toEqual([
      `1. [ACME-43 core.pubsub for events and RPC](${url("ACME-43")}) (running: addressing review on [PR #12](${PR}))`,
    ]);
  });

  it("puts the ticket's own item and its follow-ups on one line", () => {
    const groups = groupWork([ticket, review]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["w1", "w2"]);
    expect(formatWorkGroups(groups, url)[0]).toContain("(running: addressing review on");
  });

  it("does not repeat a ticket key the title already has", () => {
    const [line] = formatWorkGroups(
      groupWork([{ ...ticket, ticketTitle: "ACME-43 core.pubsub" }]),
      url,
    );

    expect(line).toBe(`1. [ACME-43 core.pubsub](${url("ACME-43")})`);
  });

  it("groups by pull request when there is no ticket", () => {
    const { ticketKey: _k, ticketTitle: _t, ...noTicket } = review;
    const groups = groupWork([
      noTicket,
      { ...noTicket, id: "w3", kind: "ci_failed", status: "queued" },
    ]);

    expect(groups).toHaveLength(1);
    expect(formatWorkGroups(groups, url)).toEqual([
      `1. [PR #12 feat(core): add core.pubsub (ACME-43)](${PR}) (running: addressing review; queued: CI failed)`,
    ]);
  });

  it("numbers one line per piece of work, in order", () => {
    const other = { id: "w9", title: "Fix footer", status: "queued", ticketKey: "ACME-44" };
    const lines = formatWorkGroups(groupWork([review, other, ticket]), url);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^2\. \[ACME-44 Fix footer\]/);
  });
});
