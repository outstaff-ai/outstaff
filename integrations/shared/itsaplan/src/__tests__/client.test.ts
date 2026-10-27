import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import type { Logger, TeamConfig } from "@outstaff/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Itsaplan } from "../client.js";
import { buildFetch } from "../fetch.js";
import type { ItsaplanHttp } from "../http.js";
import { connectionOptions, resolveConnection } from "../options.js";
import type { ApiProject } from "../types.js";

// The default TLS fetch loads undici on demand; the double records what it is asked to do instead of connecting.
const undici = vi.hoisted(() => ({
  agents: [] as { options: { connect: { ca: string[] } } }[],
  calls: [] as { input: unknown; init: Record<string, unknown> }[],
}));

vi.mock("undici", () => ({
  Agent: class {
    constructor(readonly options: { connect: { ca: string[] } }) {
      undici.agents.push(this);
    }
  },
  fetch: async (input: unknown, init: Record<string, unknown>) => {
    undici.calls.push({ input, init });
    return new Response("{}");
  },
}));

const connect = (over: Record<string, unknown> = {}) =>
  resolveConnection(
    { team: { integrations: {} } as unknown as TeamConfig },
    connectionOptions.parse({ url: "https://tracker.acme.example/", project: "SHOP", ...over }),
  );

const project = (over: Partial<ApiProject> = {}): ApiProject => ({
  project: { id: 1, key: "SHOP", ref: "acme.SHOP", name: "Shop", teamRef: "acme" },
  columns: [],
  labels: [],
  assignees: [],
  ...over,
});

const recorder = () => {
  const lines: [string, string][] = [];
  const log: Logger = {
    debug: (m) => void lines.push(["debug", m]),
    info: (m) => void lines.push(["info", m]),
    warn: (m) => void lines.push(["warn", m]),
    error: (m) => void lines.push(["error", m]),
  };

  return { log, lines };
};

const stubHttp = (reply: () => unknown) => {
  const request = vi.fn<() => Promise<unknown>>(async () => reply());
  return { http: { request } as unknown as ItsaplanHttp, request };
};

const teamOf = (value: unknown) => value as TeamConfig;

describe("custom CA through undici", () => {
  const dirs: string[] = [];
  afterEach(() => {
    undici.agents.length = 0;
    undici.calls.length = 0;
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("reads the PEM from disk and trusts it next to the system roots on every call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "itsaplan-ca-"));
    dirs.push(dir);
    const file = join(dir, "ca.pem");
    writeFileSync(file, "PEM FROM DISK");

    const f = await buildFetch(fetch, connect({ ca_file: file }));
    await f("https://api.tracker.acme.example/me", { method: "GET" });

    expect(undici.agents).toHaveLength(1);
    expect(undici.agents[0]?.options.connect.ca).toEqual([...rootCertificates, "PEM FROM DISK"]);
    expect(undici.calls).toHaveLength(1);
    expect(undici.calls[0]?.input).toBe("https://api.tracker.acme.example/me");
    expect(undici.calls[0]?.init).toMatchObject({ method: "GET", dispatcher: undici.agents[0] });
  });

  it("reports a ca_file that does not exist as invalid", async () => {
    await expect(
      buildFetch(fetch, connect({ ca_file: join(tmpdir(), "itsaplan-missing", "ca.pem") })),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("members", () => {
  const client = (agents: string[], team?: unknown) =>
    new Itsaplan(stubHttp(() => project()).http, connect({ agents }), {
      team: teamOf(team),
      now: () => new Date(0),
    });

  it("tells agents from humans by kind, listed username, team handle or listed name", () => {
    const api = client(["Robot Rae"], { people: [{ handle: "sam" }] });
    const kind = (a: Parameters<Itsaplan["toMember"]>[0]) => api.toMember(a).kind;

    expect(kind({ userId: "1", name: "A", kind: "agent" })).toBe("agent");
    expect(kind({ userId: "2", name: "B", username: "sam" })).toBe("agent");
    expect(kind({ userId: "3", name: "Robot Rae", username: null })).toBe("agent");
    expect(kind({ userId: "4", name: "Rio", username: "rio" })).toBe("human");
  });

  it("reports a member without a username or team as human, with no username key", () => {
    expect(client([]).toMember({ userId: "9", name: "Rio", username: null })).toEqual({
      id: "9",
      name: "Rio",
      kind: "human",
    });
  });

  it("falls back to the id or a placeholder for a user the project does not list", () => {
    const api = client([]);
    expect(api.member(project(), "u-x", "Xavier")).toMatchObject({ id: "u-x", name: "Xavier" });
    expect(api.member(project(), "u-x")).toMatchObject({ id: "u-x", name: "u-x" });
    expect(api.member(project(), null)).toMatchObject({ id: "unknown", name: "unknown" });
  });

  it("resolves a reference by id, username or name, and refuses a stranger", () => {
    const api = client([]);
    const setup = project({
      assignees: [{ userId: "u-1", name: "Rio Park", username: null }],
    });

    expect(api.resolveMemberId(setup, "u-1")).toBe("u-1");
    expect(api.resolveMemberId(setup, "RIO PARK")).toBe("u-1");
    expect(() => api.resolveMemberId(setup, "ghost")).toThrowError(/not a member of SHOP/);
  });
});

describe("workspace", () => {
  const clock = (at = 1_000_000) => {
    const t = { at };
    return { t, now: () => new Date(t.at) };
  };

  it("backs off after a failure, doubling the wait, and logs why", async () => {
    const { log, lines } = recorder();
    const time = clock();
    const { http, request } = stubHttp(() =>
      project({ project: { ...project().project, teamRef: "" } }),
    );

    const api = new Itsaplan(http, connect(), { team: teamOf({}), now: time.now, log });

    await api.ensureWorkspace();
    expect(request).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([["debug", "could not resolve the Its a Plan workspace"]]);

    time.t.at += 4_999;
    await api.ensureWorkspace();
    expect(request).toHaveBeenCalledTimes(1);

    time.t.at += 1;
    await api.ensureWorkspace();
    expect(request).toHaveBeenCalledTimes(2);

    time.t.at += 9_999;
    await api.ensureWorkspace();
    expect(request).toHaveBeenCalledTimes(2);

    time.t.at += 1;
    await api.ensureWorkspace();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("stops asking once a workspace is known", async () => {
    const time = clock();
    const { http, request } = stubHttp(() => project());
    const api = new Itsaplan(http, connect(), { team: teamOf({}), now: time.now });

    await api.ensureWorkspace();
    await api.ensureWorkspace();
    expect(api.workspace).toBe("acme");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refuses a project without a workspace when asked to load it", async () => {
    const { teamRef: _teamRef, ...unnamed } = project().project;
    const { http } = stubHttp(() => project({ project: unnamed }));

    const api = new Itsaplan(http, connect(), { team: teamOf({}), now: () => new Date(0) });
    await expect(api.loadWorkspace()).rejects.toMatchObject({ code: "invalid" });
    expect(api.workspace).toBeUndefined();
  });
});

describe("links", () => {
  const client = (over: Record<string, unknown> = {}, workspace?: string) => {
    const api = new Itsaplan(stubHttp(() => project()).http, connect(over), {
      team: teamOf({}),
      now: () => new Date(0),
    });

    api.workspace = workspace;
    return api;
  };

  it("keeps a placeholder it has no value for and does not encode the base address", () => {
    const api = client({ issue_url: "{url}/{nope}/{key}" }, "acme");
    expect(api.issueUrl("SHOP 1")).toBe("https://tracker.acme.example/{nope}/SHOP%201");
  });

  it("leaves {workspace} in a template untouched while the workspace is unknown, then fills it", () => {
    const api = client({ issue_comment_url: "{url}/{workspace}/{key}#{commentId}" });
    expect(api.issueCommentUrl("SHOP-1", "7")).toBe(
      "https://tracker.acme.example/{workspace}/SHOP-1#7",
    );

    api.workspace = "acme";
    expect(api.issueCommentUrl("SHOP-1", "7")).toBe("https://tracker.acme.example/acme/SHOP-1#7");
  });

  it("takes the last part of a <docId>:<id> comment id and falls back to the document link", () => {
    const withTemplate = client({ doc_comment_url: "{url}/d/{id}#c{commentId}" }, "acme");
    expect(withTemplate.docCommentUrl("D1", "D1:42")).toBe("https://tracker.acme.example/d/D1#c42");
    expect(withTemplate.docCommentUrl("D1", "42")).toBe("https://tracker.acme.example/d/D1#c42");

    const without = client({}, "acme");
    expect(without.docCommentUrl("D1", "D1:42")).toBe(without.docUrl("D1"));
  });

  it("warns once while the workspace is unknown and builds the bare shape", () => {
    const { log, lines } = recorder();
    const api = new Itsaplan(stubHttp(() => project()).http, connect(), {
      team: teamOf({}),
      now: () => new Date(0),
      log,
    });

    expect(api.issueUrl("SHOP-1")).toBe("https://tracker.acme.example/SHOP-1");
    expect(api.docUrl("D1")).toBe("https://tracker.acme.example/SHOP/docs/D1");
    expect(lines.filter(([level]) => level === "warn")).toHaveLength(1);
  });
});
