import type { Filed } from "@outstaff/protocol";
import { describe, expect, it } from "vitest";
import { acknowledgement, acknowledgements } from "#/runner/chat-acknowledge.js";
import { linksToList, reportBody } from "#/runner/chat-report.js";

const filed = (over: Partial<Filed> = {}) =>
  ({
    item: { id: "w9", title: "Filed", status: "queued" },
    waiting: false,
    work: [],
    ...over,
  }) as Filed;

const issueUrl = (key: string) => `https://t.acme.example/${key}`;

describe("acknowledgement", () => {
  it("names the ticket the request was filed as, linked", () => {
    expect(acknowledgement({ key: "ACME-1", title: "x" }, filed(), issueUrl)).toBe(
      "On it. Tracked in [ACME-1](https://t.acme.example/ACME-1).",
    );
  });

  it("says a request without a ticket is queued", () => {
    expect(acknowledgement({ title: "Tidy up" }, filed(), () => undefined)).toBe(
      "On it. Queued: Tidy up.",
    );
  });

  it("names the work a request was added to, and when running work picks it up", () => {
    const what = {
      title: "x",
      attached: {
        pr: { ref: "app#3", url: "https://g.example/pull/3" },
        ticket: { ref: "ACME-2" },
      },
    } as Parameters<typeof acknowledgement>[0];

    expect(
      acknowledgement(
        what,
        filed({ item: { id: "w9", title: "Filed", status: "active" } } as Partial<Filed>),
        issueUrl,
      ),
    ).toBe(
      "Adding this to [PR app#3](https://g.example/pull/3) for [ACME-2](https://t.acme.example/ACME-2). I'll pick it up when the current round ends.",
    );
  });

  describe("with the agent's own line", () => {
    const links = "[PR #88](https://g.example/pull/88) · [ACME-54](https://t.acme.example/ACME-54)";
    const attached = (say: string) =>
      ({
        title: "x",
        say,
        attached: {
          pr: { ref: "#88", url: "https://g.example/pull/88" },
          ticket: { ref: "ACME-54" },
        },
      }) as Parameters<typeof acknowledgement>[0];

    const active = filed({
      item: { id: "w9", title: "Filed", status: "active" },
    } as Partial<Filed>);

    it("leads with the line, then the links of the work it joined", () => {
      expect(acknowledgement(attached("Reworking it on the operator."), filed(), issueUrl)).toBe(
        `Reworking it on the operator. ${links}`,
      );
    });

    it("adds when running work picks it up, unless the line says when", () => {
      expect(acknowledgement(attached("Got it, the review fixes."), active, issueUrl)).toBe(
        `Got it, the review fixes. ${links} I'll pick it up when the current round ends.`,
      );

      expect(
        acknowledgement(attached("Reworking it once this round ends."), active, issueUrl),
      ).toBe(`Reworking it once this round ends. ${links}`);
    });

    it("leads with the line, then the ticket it was filed as", () => {
      const what = { key: "ACME-1", title: "x", say: "Will do, the CSV export." };
      expect(acknowledgement(what, filed(), issueUrl)).toBe(
        "Will do, the CSV export. [ACME-1](https://t.acme.example/ACME-1)",
      );
    });
  });
});

describe("reports", () => {
  it("words each kind of report", () => {
    expect(reportBody("result", " Done. ")).toBe("Done.");
    expect(reportBody("blocked", "Need a key.")).toBe("I am blocked. Need a key.");
    expect(reportBody("failed", "boom\nmore")).toBe(
      "I hit an error and could not finish this. I will try again. boom",
    );
  });

  it("lists each link once, and none the body already shows", () => {
    const a = { url: "https://a.example" };
    const b = { url: "https://b.example" };
    expect(linksToList([a, b, a], "see https://b.example")).toEqual([a]);
  });
});

describe("acknowledgements: one reply for a chat session", () => {
  const ticket = (key: string, say?: string) => ({
    what: { key, title: key, ...(say ? { say } : {}) },
    filed: filed(),
  });

  it("reads like one acknowledgement for one filing", () => {
    expect(acknowledgements([ticket("ACME-1")], issueUrl)).toBe(
      "On it. Tracked in [ACME-1](https://t.acme.example/ACME-1).",
    );
  });

  it("names every ticket the session filed in one line", () => {
    expect(acknowledgements([ticket("ACME-1"), ticket("ACME-2"), ticket("ACME-3")], issueUrl)).toBe(
      "On it. Tracked in [ACME-1](https://t.acme.example/ACME-1), [ACME-2](https://t.acme.example/ACME-2) and [ACME-3](https://t.acme.example/ACME-3).",
    );
  });

  it("leads with the agent's own lines, then the links", () => {
    const filings = [ticket("ACME-1", "Filed the plan."), ticket("ACME-2", "Filed the plan.")];
    expect(acknowledgements(filings, issueUrl)).toBe(
      "Filed the plan. [ACME-1](https://t.acme.example/ACME-1), [ACME-2](https://t.acme.example/ACME-2)",
    );
  });

  it("gives queued requests and joined work lines of their own", () => {
    const filings = [
      ticket("ACME-1"),
      { what: { title: "Tidy up" }, filed: filed() },
      { what: { title: "Sort it" }, filed: filed() },
      { what: { title: "x", attached: { ticket: { ref: "ACME-9" } } }, filed: filed() },
    ] as Parameters<typeof acknowledgements>[0];

    expect(acknowledgements(filings, issueUrl)).toBe(
      [
        "On it. Tracked in [ACME-1](https://t.acme.example/ACME-1).",
        "On it. Queued: Tidy up and Sort it.",
        "Adding this to [ACME-9](https://t.acme.example/ACME-9).",
      ].join("\n"),
    );
  });
});
