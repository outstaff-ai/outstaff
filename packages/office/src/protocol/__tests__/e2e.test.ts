import {
  findVerb,
  runVerb,
  createOfficeConnection,
  type AgentEnv,
  type OfficeConnection,
} from "@outstaff/agent";
import type { TeamConfig } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "../../clock.js";
import { createAgentAuth } from "../auth.js";
import { createProtocolServer } from "../server.js";
import type { Messaging } from "../source.types.js";
import { createFakeSource, type FakeSource } from "@outstaff/testing.office";
import type { ProtocolServer } from "../types.js";

// Only the people matter to the office verbs.
const team = { people: [{ handle: "ada" }, { handle: "noor" }] } as unknown as TeamConfig;

describe("office verbs through the real client and server", () => {
  let source: FakeSource;
  let server: ProtocolServer;
  let conn: OfficeConnection;
  let questions: { from: string; to: string; question: string; workItemId?: string | undefined }[];
  let env: AgentEnv;

  beforeEach(async () => {
    source = createFakeSource([
      { handle: "ada", name: "Ada", role: "developer", status: "working", current: "w1" },
      { handle: "noor", name: "Noor", role: "reviewer", status: "idle" },
    ]);

    questions = [];
    const messaging: Messaging = {
      async ask(from, q) {
        questions.push({ from, ...q });
        return q.question.includes("urgent")
          ? { id: "q1", to: q.to, status: "answered", answer: "Go ahead." }
          : { id: "q2", to: q.to, status: "pending" };
      },
      async answer() {},
    };

    const clock = manualClock();
    server = createProtocolServer({
      source,
      messaging,
      auth: createAgentAuth({ ada: "ada-token" }),
      clock,
      port: 0,
      host: "127.0.0.1",
    });

    await server.start();
    conn = createOfficeConnection({
      url: `ws://127.0.0.1:${server.port()}/agent`,
      person: "ada",
      token: "ada-token",
      agentVersion: "test",
      clock,
    });

    conn.start();
    await conn.whenConnected();
    env = {
      person: "ada",
      team,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      office: conn,
    } as AgentEnv;
  });

  afterEach(async () => {
    await conn.stop();
    await server.stop();
  });

  const run = (name: string, input: unknown = {}, ctx = {}) => {
    const verb = findVerb(name);
    if (!verb) {
      throw new Error(`no verb ${name}`);
    }

    return runVerb(verb, env, input, ctx);
  };

  it("asks a teammate and gets an immediate or a pending answer", async () => {
    const quick = await run("ask", { to: "noor", question: "Is it urgent?" }, { workItemId: "w1" });
    expect(quick.text).toContain("noor answered: Go ahead.");
    const slow = await run("ask", { to: "noor", question: "Later?" });
    expect(slow.text).toContain("no answer yet (question q2)");
    expect(questions).toEqual([
      { from: "ada", to: "noor", question: "Is it urgent?", workItemId: "w1" },
      { from: "ada", to: "noor", question: "Later?" },
    ]);
  });

  it("lists the work of the caller", async () => {
    source.enqueue("ada", "w1", "Build the cart");
    source.enqueue("noor", "w2", "Not mine");
    const r = await run("work", {}, { workItemId: "w1" });
    expect(r.text).toContain("* w1 [queued] Build the cart");
    expect(r.text).not.toContain("w2");
  });

  it("lists the team", async () => {
    const r = await run("team");
    expect(r.text).toContain("ada (Ada), developer: working, w1");
    expect(r.text).toContain("noor (Noor), reviewer: idle");
  });

  it("shows protocol errors as verb errors", async () => {
    await expect(conn.accept("missing")).rejects.toMatchObject({ code: "not_found" });
  });

  it("delivers an offer to the offers stream and takes it through to a hand-back", async () => {
    source.enqueue("ada", "w1", "Build the cart");
    server.notify("ada");
    const stream = conn.offers()[Symbol.asyncIterator]();
    const { value: offer } = await stream.next();
    expect(offer?.workItem.title).toBe("Build the cart");
    await conn.accept("w1");
    await conn.progress("w1", "started");
    await conn.journal("w1", "decided");
    await conn.handBack("w1", { summary: "done", status: "done" });
    expect(source.stateOf("w1")).toBe("done");
  });
});
