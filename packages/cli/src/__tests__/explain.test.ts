import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreTraceStore, openStore, type Trace } from "@outstaff/office";
import { afterAll, describe, expect, it } from "vitest";
import type { Context } from "#/types.js";
import { run } from "#/program.js";

const dir = mkdtempSync(join(tmpdir(), "ost-explain-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const url = `sqlite://${join(dir, "office.db")}`;

const trace: Trace = {
  event: {
    id: "tracker:e-1",
    type: "ticket.assigned",
    at: "2026-10-05T09:00:00.000Z",
    subject: { ticket: "ACME-150" },
    actor: { kind: "human", id: "ada.admin" },
    data: {},
  },
  policies: [
    {
      policy: "assigned_to_assignee",
      matched: true,
      reason: "all conditions hold",
      decisions: [
        {
          type: "wake",
          policy: "assigned_to_assignee",
          person: "sam",
          kind: "assigned",
          instruction: "ACME-150 is assigned to you.",
          feedback: [],
          subject: { type: "ticket", ref: "ACME-150" },
        },
      ],
    },
  ],
  decisions: [],
};

trace.decisions = trace.policies[0]!.decisions;

async function ost(args: string[], env: Record<string, string> = {}, extra: Partial<Context> = {}) {
  let out = "";
  let err = "";
  const ctx: Context = {
    cwd: dir,
    env,
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    gitOrigin: () => undefined,
    ...extra,
  };

  return { code: await run(args, ctx), out, err };
}

describe("ost explain", () => {
  it("prints the trace the office recorded for an event, from the store in OUTSTAFF_STORE_URL", async () => {
    const store = await openStore(url);
    await createStoreTraceStore(store).record(trace);
    await store.close();

    const r = await ost(["explain", "tracker:e-1"], { OUTSTAFF_STORE_URL: url });
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(r.out).toContain("ticket.assigned on ACME-150 by human ada.admin");
    expect(r.out).toContain("  matched  assigned_to_assignee: all conditions hold");
    expect(r.out).toContain("    instruction: ACME-150 is assigned to you.");

    const json = await ost(["explain", "tracker:e-1", "--store", url, "--json"]);
    expect(JSON.parse(json.out)).toEqual(trace);
  });

  it("lists the latest traced events", async () => {
    expect(await ost(["explain", "--recent", "5", "--store", url])).toEqual({
      code: 0,
      out: "2026-10-05T09:00:00.000Z  ticket.assigned  tracker:e-1\n    wake sam (assigned) on ticket ACME-150\n",
      err: "",
    });

    const json = await ost(["explain", "--recent", "5", "--store", url, "--json"]);
    expect(JSON.parse(json.out)).toEqual([trace]);
  });

  it("says what is missing", async () => {
    expect(await ost(["explain", "tracker:e-1"])).toMatchObject({
      code: 1,
      err: "error    Give the office store with --store or OUTSTAFF_STORE_URL.\n",
    });

    expect(await ost(["explain", "--store", url])).toMatchObject({
      code: 1,
      err: "error    Give an event id, or --recent <n> to list the latest ones.\n",
    });

    expect(await ost(["explain", "--recent", "two", "--store", url])).toMatchObject({
      code: 1,
      err: "error    --recent takes a whole number above 0.\n",
    });

    expect(await ost(["explain", "vcs:nope", "--store", url])).toMatchObject({
      code: 1,
      err: "error    No trace for vcs:nope. Is it an event id as the office logs it?\n",
    });
  });

  it("says when the office package is not installed next to the CLI", async () => {
    const missing = () => Promise.reject(new Error("Cannot find package '@outstaff/office'"));
    expect(
      await ost(["explain", "tracker:e-1", "--store", url], {}, { loadOffice: missing }),
    ).toMatchObject({
      code: 1,
      err: "error    ost explain reads the office store and needs @outstaff/office installed next to the CLI.\n",
    });
  });

  it("does not migrate a store the office has not, and says it cannot read it", async () => {
    const r = await ost(["explain", "tracker:e-1", "--store", `sqlite://${join(dir, "empty.db")}`]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^error {4}Could not read the office store: .*pipeline_traces/);
  });
});
