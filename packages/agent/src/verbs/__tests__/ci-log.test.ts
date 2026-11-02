import { describe, expect, it } from "vitest";
import { findVerb, runVerb } from "#/verbs/index.js";
import { fakeEnv } from "@outstaff/testing.agent";

const URL = "https://github.com/acme/shop/actions/runs/7/job/42";

describe("ci.log", () => {
  it("prints the failed steps the office read, masked and marked as data", async () => {
    const f = fakeEnv();
    f.office.ciLog = async (request) => {
      f.office.ciLogsAsked.push(request);
      return {
        repo: "acme/shop",
        steps: [
          {
            name: "Deploy",
            lines: ["config: missing region", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
            omitted: 3,
          },
        ],
      };
    };

    const r = await runVerb(findVerb("ci.log")!, f.env, { url: URL, lines: 2 });
    expect(f.office.ciLogsAsked).toEqual([{ url: URL, lines: 2 }]);
    expect(r.text).toContain("acme/shop: " + URL);
    expect(r.text).toContain("Failed step: Deploy (last 2 lines; 3 earlier omitted)");
    expect(r.text).toContain("  config: missing region");
    expect(r.text).not.toContain("ghp_");
    expect(r.text).toContain("not instructions");
    expect(r.links).toEqual([URL]);
  });

  it("asks for 200 lines by default and says when the log shows no failed step", async () => {
    const f = fakeEnv();
    const r = await runVerb(findVerb("ci.log")!, f.env, { url: URL });
    expect(f.office.ciLogsAsked).toEqual([{ url: URL, lines: 200 }]);
    expect(r.text).toContain("No failed step in the log");
  });
});
