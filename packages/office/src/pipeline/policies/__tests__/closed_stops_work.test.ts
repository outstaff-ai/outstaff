import { runPolicy, type PipelineEvent } from "@outstaff/policy";
import { describe, expect, it } from "vitest";
import { describeProposal } from "#/pipeline/describe.js";
import { policy } from "#/pipeline/policies/closed_stops_work.js";
import { ADA, OPTS, SAM, event, judge, stateOf, t, traceOf, type World } from "./support.js";

const WORKSTATE = { kind: "automation" as const, id: "workstate" };
const BOT = { kind: "automation" as const, id: "tracker-bot" };
const MIRA = { kind: "agent" as const, id: "mira" };

/** ACME-144 was just closed, at 18:22:16. */
const closed = (status: "done" | "canceled", closedBy?: PipelineEvent["actor"]) =>
  event("ticket.closed", {
    subject: { ticket: "ACME-144" },
    actor: WORKSTATE,
    data: { status, ...(closedBy ? { closedBy } : {}), at: "2026-11-02T18:22:16.000Z" },
  });

const world = (status: "done" | "canceled" | "active"): World => ({
  tickets: { "ACME-144": t(status, "sam") },
});

describe("closed_stops_work", () => {
  it("stops every agent's work on a ticket a human canceled, telling the running agent who and when", () => {
    expect(judge("closed_stops_work", closed("canceled", ADA), world("canceled"))).toEqual([
      "stop the work on ACME-144",
    ]);

    expect(traceOf(closed("canceled", ADA), world("canceled")).decisions).toEqual([
      {
        type: "stop",
        policy: "closed_stops_work",
        ticket: "ACME-144",
        notice:
          "ACME-144 was canceled by ada-admin at 18:22 UTC. Stop, and don't open a pull request for it. If the work belongs to another ticket, say which and hand back.",
        except: [],
      },
    ]);
  });

  it("stops the work on a ticket a human closed as done", () => {
    const [d] = traceOf(closed("done", ADA), world("done")).decisions;
    expect(d).toMatchObject({ type: "stop", except: [] });
    expect(d).toHaveProperty(
      "notice",
      expect.stringMatching(/^ACME-144 was closed as done by ada-admin/),
    );
  });

  it("leaves the agent who closed its own ticket after merging alone, and stops the others", () => {
    expect(judge("closed_stops_work", closed("done", SAM), world("done"))).toEqual([
      "stop the work on ACME-144, except sam's",
    ]);

    // Another agent closing it as done stops sam's work.
    expect(traceOf(closed("done", MIRA), world("done")).decisions).toMatchObject([
      { type: "stop", except: ["mira"] },
    ]);
  });

  it("spares the agent who canceled the ticket itself", () => {
    expect(traceOf(closed("canceled", SAM), world("canceled")).decisions).toMatchObject([
      { type: "stop", except: ["sam"] },
    ]);
  });

  it("stops nothing for a ticket closed as done by no one known or by an automation", () => {
    expect(traceOf(closed("done"), world("done")).decisions).toEqual([
      {
        type: "drop",
        policy: "closed_stops_work",
        reason: "closed as done, and who closed it is not known: it may be the agent's own merge",
      },
    ]);

    expect(traceOf(closed("done", BOT), world("done")).decisions).toMatchObject([
      {
        type: "drop",
        reason: "closed as done by automation tracker-bot, which may follow the agent's own merge",
      },
    ]);
  });

  it("stops a canceled ticket whoever closed it, naming someone when no one is known", () => {
    expect(traceOf(closed("canceled"), world("canceled")).decisions).toMatchObject([
      {
        type: "stop",
        except: [],
        notice: expect.stringMatching(/^ACME-144 was canceled by someone at 18:22 UTC/),
      },
    ]);
  });

  it("stops nothing once the ticket is open again", () => {
    expect(judge("closed_stops_work", closed("canceled", ADA), world("active"))).toMatchObject({
      failed: { ticket_status: ["done", "canceled"] },
    });
  });

  it("gives its reason, and says when its notice cannot be rendered", () => {
    const run = traceOf(closed("canceled", ADA), world("canceled"));
    expect(run.policies.find((p) => p.policy === "closed_stops_work")?.proposals).toEqual([
      expect.objectContaining({ type: "stop", reason: "ACME-144 was canceled by human ada-admin" }),
    ]);

    const input = {
      event: closed("canceled", ADA),
      state: stateOf(world("canceled")),
      options: OPTS,
    };

    expect(runPolicy({ ...policy, instruction: "{{unknown}}" }, input).proposals).toEqual([
      { type: "drop", reason: expect.stringMatching(/^the notice cannot be rendered: /) },
    ]);

    expect(
      describeProposal({
        type: "stop",
        ticket: "ACME-144",
        notice: "n",
        except: ["sam"],
        reason: "r",
      }),
    ).toBe("stop the work on ACME-144, except sam's");

    expect(describeProposal({ type: "stop", ticket: "ACME-144", notice: "n", reason: "r" })).toBe(
      "stop the work on ACME-144",
    );
  });
});
