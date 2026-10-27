import type { ThreadNode } from "@outstaff/integration.vcs.github";
import type { StoredThread, StubRequest } from "#/types.js";

export const OWN_APP = 201;
export const OFFICE_APP = 100;
export const installationOf = (appId: number) => appId + 1000;

export const appOf = (req: StubRequest): number => {
  const token = req.headers.get("authorization")!.slice("Bearer ".length);
  return Number(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).iss);
};

/** Installation tokens are issued as `tok_<person>`; the office's is `tok_office`. */
export const actorOf = (req: StubRequest): string => {
  const token = req.headers.get("authorization")!.slice("Bearer ".length);
  return token.startsWith("tok_") ? token.slice(4) : "unknown";
};

export const personOf = (appId: number) => (appId === OWN_APP ? "sam" : undefined);

export const toNode = (t: StoredThread): ThreadNode => ({
  id: t.id,
  isResolved: t.resolved,
  path: t.path ?? null,
  line: t.line ?? null,
  originalLine: null,
  comments: {
    nodes: t.comments.map((c) => ({
      id: c.id,
      databaseId: c.databaseId,
      body: c.body,
      author: { login: c.author },
    })),
  },
});

export const LOG_ORIGIN = "https://logs.github.test";
