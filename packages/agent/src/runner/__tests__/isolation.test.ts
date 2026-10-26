import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPolicy,
  evaluate,
  type RunRequest,
  type Runtime,
  type RuntimeEvent,
} from "@outstaff/core";
import type { Message } from "@outstaff/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createOfficeConnection } from "../../office-client/index.js";
import { FakeSocket, createManualClock } from "../../office-client/testing.js";
import type { Workspaces } from "../../repos/index.js";
import { fakeEnv } from "../../verbs/testing.js";
import { JOURNAL_PROMPT } from "../journal.js";
import { createWorkLoop } from "../loop.js";

/** An office that acknowledges everything and keeps a question open, so an item waits. */
class OfficeSocket extends FakeSocket {
  override send(data: string) {
    super.send(data);
    this.settle();
    const m = this.last();
    if (m.type === "hello") {
      return;
    }

    queueMicrotask(() =>
      m.type === "ask"
        ? this.reply(m, "ask_result", { id: "q1", to: m.payload.to, status: "pending" })
        : this.reply(m, "ack"),
    );
  }

  private waiters: { type: string; count: number; resolve: () => void }[] = [];

  /** Resolves once the client has sent `count` messages of a type, so tests await the event itself. */
  whenSent(type: string, count: number) {
    return new Promise<void>((resolve) => {
      this.waiters.push({ type, count, resolve });
      this.settle();
    });
  }

  private settle() {
    this.waiters = this.waiters.filter((w) => {
      const done = this.sentOf(w.type).length >= w.count;
      if (done) {
        w.resolve();
      }

      return !done;
    });
  }

  offer(id: string, sessionId?: string) {
    this.receive({
      id: `offer-${id}-${this.sent.length}`,
      type: "offer",
      payload: {
        workItem: { id, kind: "ticket", title: `Fix ${id}`, priority: 1, trigger: "human" },
        context: { journal: [], subjects: [], links: [] },
        ...(sessionId ? { sessionId } : {}),
      },
    });
  }
}

const layoutOf = (home: string) => ({
  home,
  workDir: join(home, "work"),
  reposDir: join(home, "repos"),
  worktreesDir: join(home, "worktrees"),
  scratchDir: join(home, "scratch"),
  memoryDir: join(home, "memory"),
  secretsDir: "/run/secrets",
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ost-isolation-"));
  dirs.push(home);
  const layout = layoutOf(home);
  for (const d of [layout.workDir, layout.worktreesDir, layout.scratchDir, layout.memoryDir]) {
    mkdirSync(d, { recursive: true });
  }

  const { env } = fakeEnv();
  const policy = buildPolicy({
    profile: "code",
    person: env.team.people[0]!,
    team: env.team,
    layout,
  });

  return { home, layout, env, policy };
}

describe("isolation between work items", () => {
  it("keeps sessions, worktrees, scratch and journals apart when two items alternate", async () => {
    const { layout, env, policy } = setup();
    const clock = createManualClock();
    const socket = new OfficeSocket();
    const conn = createOfficeConnection({
      url: "ws://office.test/agent",
      person: "sam",
      token: "t",
      agentVersion: "test",
      clock,
      socket: () => socket,
    });

    conn.start();
    socket.open();
    socket.welcome();
    await conn.whenConnected();

    // Directories on disk, one per item, like the real workspaces.
    const released = new Map<string, () => void>();
    const whenReleased = (id: string) => new Promise<void>((resolve) => released.set(id, resolve));
    const workspaces: Workspaces = {
      async prepare(o) {
        const id = o.workItem.id;
        const worktree = join(layout.worktreesDir, "shop", id);
        const scratch = join(layout.scratchDir, id);
        mkdirSync(worktree, { recursive: true });
        mkdirSync(scratch, { recursive: true });
        return { repo: "shop", worktree, branch: `ticket/${id}`, scratch, conventionFiles: [] };
      },
      async release(id) {
        rmSync(join(layout.worktreesDir, "shop", id), { recursive: true, force: true });
        rmSync(join(layout.scratchDir, id), { recursive: true, force: true });
        released.get(id)?.();
      },
    };

    const rounds = new Map<string, number>();
    const requests: RunRequest[] = [];
    const runtime: Runtime = {
      async *run(req) {
        requests.push(req);
        const id = req.workItemId!;
        const session = `session-${id}`;
        if (req.sessionId !== undefined && req.sessionId !== session) {
          yield { type: "finished", ok: false, text: "", sessionLost: true };
          return;
        }

        yield { type: "started", sessionId: session } satisfies RuntimeEvent;
        const n = rounds.get(id) ?? 0;
        if (req.prompt === JOURNAL_PROMPT) {
          yield {
            type: "finished",
            ok: true,
            text: `Done: ${id} round ${n}\nDecisions: ${id} only\nOpen: none\nLinks: none`,
          };

          return;
        }

        rounds.set(id, n + 1);
        const [worktree, scratch] = req.addDirs.slice(-2) as [string, string];
        writeFileSync(join(worktree, `${id}-${n}.txt`), `${id} round ${n}`);
        writeFileSync(join(scratch, `${id}-${n}.md`), `${id} round ${n}`);
        // Rounds 0 and 1 leave a question open; round 2 finishes the item.
        if (n < 2) {
          await req.tools
            .find((t) => t.name === "ask")!
            .handler({ to: "mira", question: `${id}?` }, { workItemId: id });
        }

        yield { type: "finished", ok: true, text: `${id} round ${n}` };
      },
    };

    const loop = createWorkLoop({
      office: conn,
      runtime,
      env: { ...env, office: conn },
      systemPrompt: "IDENTITY",
      policy,
      builtinTools: ["read", "ost"],
      workdir: layout.workDir,
      addDirs: [layout.reposDir],
      workspaces,
    });

    const running = loop.run();
    const sent = (type: string) => socket.sentOf(type) as Message[];
    const stored = new Map<string, string>();
    let handBacks = 0;
    const play = async (id: string) => {
      socket.offer(id, stored.get(id));
      handBacks += 1;
      await socket.whenSent("handback", handBacks);
      for (const m of sent("session")) {
        const p = m.payload as { workItemId: string; sessionId: string };
        stored.set(p.workItemId, p.sessionId);
      }
    };

    await play("a1");
    await play("b1");
    await play("a1");

    // Both items wait, and each still has its own files and nobody else's.
    const wt = (id: string) => join(layout.worktreesDir, "shop", id);
    const sc = (id: string) => join(layout.scratchDir, id);
    expect(readdirSync(wt("a1")).toSorted()).toEqual(["a1-0.txt", "a1-1.txt"]);
    expect(readdirSync(wt("b1"))).toEqual(["b1-0.txt"]);
    expect(readdirSync(sc("a1")).toSorted()).toEqual(["a1-0.md", "a1-1.md"]);
    expect(readdirSync(sc("b1"))).toEqual(["b1-0.md"]);

    // The workspace is released after the hand-back, so await that event too.
    const gone = [whenReleased("a1"), whenReleased("b1")];
    await play("b1");
    await play("a1");
    await play("b1");
    await Promise.all(gone);

    // Done items lose their workspaces, and only theirs.
    expect(existsSync(wt("a1")) || existsSync(wt("b1"))).toBe(false);
    expect(existsSync(sc("a1")) || existsSync(sc("b1"))).toBe(false);

    // One session per item, resumed by later rounds of that item only.
    const work = requests.filter((r) => r.prompt !== JOURNAL_PROMPT);
    expect(work.map((r) => [r.workItemId, r.sessionId])).toEqual([
      ["a1", undefined],
      ["b1", undefined],
      ["a1", "session-a1"],
      ["b1", "session-b1"],
      ["a1", "session-a1"],
      ["b1", "session-b1"],
    ]);

    expect(Object.fromEntries(stored)).toEqual({ a1: "session-a1", b1: "session-b1" });

    // Each round's directories are its item's own.
    for (const r of work) {
      expect(r.addDirs.slice(-2)).toEqual([wt(r.workItemId!), sc(r.workItemId!)]);
      // The home directory is random, so "b1" can occur in any path by chance: compare
      // the item's own words and paths, not bare substrings.
      const id = r.workItemId!;
      const other = id === "a1" ? "b1" : "a1";
      expect(r.prompt).toContain(`Work item ${id} (ticket): Fix ${id}`);
      expect(r.prompt).toContain(wt(id));
      expect(r.prompt).toContain(sc(id));
      expect(r.prompt).not.toContain(`Work item ${other}`);
      expect(r.prompt).not.toContain(`Fix ${other}`);
      expect(r.prompt).not.toContain(wt(other));
      expect(r.prompt).not.toContain(sc(other));
      expect(r.prompt).not.toContain(`session-${other}`);
    }

    // Journals: one per hand-back, each naming only its own item.
    const journals = sent("journal").map((m) => m.payload as { workItemId: string; text: string });
    expect(journals).toHaveLength(6);
    for (const j of journals) {
      const other = j.workItemId === "a1" ? "b1" : "a1";
      expect(j.text).toContain(j.workItemId);
      expect(j.text).not.toContain(other);
    }

    await loop.stop();
    await conn.stop();
    await running;
  });
});

describe("memory", () => {
  it("is in the runtime's directories and the only place besides scratch and repositories that can be written", () => {
    // A home outside the temp folder: /tmp is writable on purpose, and CI's tmpdir is /tmp.
    const { env } = fakeEnv();
    const layout = layoutOf("/home/outstaff");
    const policy = buildPolicy({
      profile: "code",
      person: env.team.people[0]!,
      team: env.team,
      layout,
    });

    const write = (path: string) => evaluate(policy, { kind: "write", path }).effect;
    expect(write(join(layout.memoryDir, "lessons.md"))).toBe("allow");
    expect(write(join(layout.home, "notes.md"))).toBe("deny");
    expect(write(join(layout.home, ".bashrc"))).toBe("deny");
    expect(write(join(layout.workDir, "skills", "x.md"))).toBe("deny");
    expect(write(join(layout.secretsDir, "token"))).toBe("deny");
  });

  it("is never written by the work loop itself", async () => {
    const { layout, env, policy } = setup();
    const clock = createManualClock();
    const socket = new OfficeSocket();
    const conn = createOfficeConnection({
      url: "ws://office.test/agent",
      person: "sam",
      token: "t",
      agentVersion: "test",
      clock,
      socket: () => socket,
    });

    conn.start();
    socket.open();
    socket.welcome();
    await conn.whenConnected();

    const { createFakeRuntime } = await import("@outstaff/core/fakes");
    const runtime = createFakeRuntime();
    runtime.enqueue([{ type: "finish", text: "Done. https://git.acme.example/pull/1" }]);
    const loop = createWorkLoop({
      office: conn,
      runtime,
      env: { ...env, office: conn },
      systemPrompt: "IDENTITY",
      policy,
      builtinTools: ["read"],
      workdir: layout.workDir,
      addDirs: [layout.memoryDir],
    });

    const running = loop.run();
    socket.offer("a1");
    await socket.whenSent("handback", 1);
    expect(readdirSync(layout.memoryDir)).toEqual([]);
    await loop.stop();
    await conn.stop();
    await running;
  });
});
