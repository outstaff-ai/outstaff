import type { Filed } from "@outstaff/protocol";
import { describe, expect, it } from "vitest";
import { acknowledgement } from "../chat-acknowledge.js";
import { linksToList, reportBody } from "../chat-report.js";

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
