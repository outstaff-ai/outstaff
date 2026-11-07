import type { Filed } from "@outstaff/protocol";
import { describe, expect, it } from "vitest";
import { filedLine } from "#/verbs/support.js";

const filed = (work: Filed["work"]): Filed => ({
  item: { id: "w3", title: "Fix the footer", status: "queued" },
  work,
});

describe("what a chat session is told after it filed work", () => {
  it("starts now when the person is idle", () => {
    expect(filedLine(filed([]))).toContain("It starts now.");
  });

  it("runs next, after the running work, when the person is busy; nothing waits for the requester", () => {
    const line = filedLine(
      filed([
        { id: "w1", title: "Checkout bug", status: "active" },
        { id: "w2", title: "Search page", status: "queued" },
      ]),
    );

    expect(line).toContain("it runs next, after the work running now");
    expect(line).toContain("who may move it");
  });
});
