import { readFileSync } from "node:fs";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { createChat } from "./chat.ts";
import { BareRepo } from "./git.ts";
import { createGithub } from "./github.ts";
import { readBody, router, type Route } from "./http.ts";
import { createTracker } from "./tracker.ts";

/**
 * Stand-ins for GitHub (API and git remote), the tracker and a chat workspace, for the end-to-end test. Configuration comes from the
 * environment so the same file runs in a container and on a laptop:
 *
 *   STUB_DATA_DIR      where the bare repository lives
 *   STUB_APPS          `<app id>=<slug>,...` the GitHub Apps that exist
 *   STUB_APP_PUBLIC_KEY  PEM file; Apps must sign their JWTs with the matching private key
 *   STUB_TRACKER_KEYS  `<api key>=<username>,...`
 *   STUB_TLS_CERT, STUB_TLS_KEY  PEM files for the https listener (git needs https)
 *   STUB_HTTP_PORT (8081), STUB_HTTPS_PORT (443)
 *
 * `/_test/*` is the driver's control surface: it acts as the humans of the acme team.
 */

const env = (key: string): string => {
  const v = process.env[key];
  if (!v) {
    throw new Error(`${key} is not set.`);
  }

  return v;
};

const pairs = (text: string) =>
  Object.fromEntries(
    text
      .split(",")
      .filter(Boolean)
      .map((p) => p.split("=") as [string, string]),
  );

const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

const repo = new BareRepo(env("STUB_DATA_DIR"), "acme", "shop");
await repo.init({
  "greeting.txt": "hello\nworld\n!\n",
  "README.md": "# Acme Shop\n",
  "CONTRIBUTING.md":
    "# Contributing to Acme Shop\n\n## Commits\n\nOne commit per pull request. To change it, amend it and push with `git push --force-with-lease`.\n",
});

const github = createGithub({
  repo,
  apps: pairs(env("STUB_APPS")),
  publicKey: readFileSync(env("STUB_APP_PUBLIC_KEY"), "utf8"),
  permissions: { "ada-admin": "write", "grace-lead": "write" },
});

const tracker = createTracker({
  projectKey: "SHOP",
  teamRef: "acme",
  columns: [
    { name: "Backlog", stateType: "backlog" },
    { name: "Ready", stateType: "unstarted" },
    { name: "In Progress", stateType: "started" },
    { name: "In Review", stateType: "started" },
    { name: "Blocked", stateType: "started" },
    { name: "Done", stateType: "completed" },
    { name: "Canceled", stateType: "canceled" },
  ],
  members: [
    { userId: "u-ada", name: "Ada Admin", username: "ada.admin", kind: "member" },
    { userId: "u-office", name: "Acme Office", username: "acme-office", kind: "agent" },
    { userId: "u-sam", name: "Sam Duarte", username: "sam", kind: "agent" },
    { userId: "u-mira", name: "Mira Okafor", username: "mira", kind: "agent" },
  ],
  keys: Object.fromEntries(
    Object.entries(pairs(env("STUB_TRACKER_KEYS"))).map(([k, user]) => [k, `u-${user}`]),
  ),
  human: "ada.admin",
});

const chat = createChat();
const ok = (body: unknown = { ok: true }) => body;
const control: Route[] = [
  { method: "GET", path: "/_test/healthz", handler: () => ok() },
  {
    method: "GET",
    path: "/_test/state",
    handler: async () => ({
      github: await github.state(),
      tickets: tracker.state(),
      chat: chat.state(),
    }),
  },
  {
    // A person edits a file on main, for example the contribution rules.
    method: "POST",
    path: "/_test/repo/file",
    handler: async (r) => {
      await repo.commitFile("main", r.json.path, r.json.text, r.json.message ?? "Update");
      return ok();
    },
  },
  {
    method: "POST",
    path: "/_test/tickets",
    handler: (r) => ({
      key: tracker.createTicket(
        r.json.title,
        r.json.description ?? "",
        r.json.status ?? "Ready",
        r.json.assignee,
      ),
    }),
  },
  {
    method: "POST",
    path: "/_test/tickets/:key/assign",
    handler: (r) => {
      tracker.assignTicket(r.params["key"]!, r.json.to);
      return ok();
    },
  },
  {
    method: "POST",
    path: "/_test/pulls/:n/review",
    handler: async (r) => {
      const event = {
        approved: "APPROVE",
        changes_requested: "REQUEST_CHANGES",
        commented: "COMMENT",
      }[r.json.state as string];

      if (!event) {
        return {
          status: 400,
          body: { message: "state: approved, changes_requested or commented" },
        };
      }

      await github.review(
        Number(r.params["n"]),
        "grace-lead",
        event,
        r.json.body ?? "",
        r.json.comments,
      );

      return ok();
    },
  },
  {
    method: "POST",
    path: "/_test/pulls/:n/comment",
    handler: async (r) => {
      await github.comment(Number(r.params["n"]), r.json.actor ?? "grace-lead", r.json.body ?? "");
      return ok();
    },
  },
  {
    method: "POST",
    path: "/_test/pulls/:n/merge",
    handler: async (r) => {
      await github.merge(Number(r.params["n"]), "grace-lead");
      return ok();
    },
  },
];

const route = router([...control, ...chat.routes, ...github.routes, ...tracker.routes]);

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const body = await readBody(req);
  const url = new URL(req.url ?? "/", "http://stub");
  const done = (status: number) =>
    log(
      `${req.method} ${url.pathname}${url.search ? "?" : ""}${url.searchParams.size ? url.search.slice(1, 80) : ""} ${status} ${Date.now() - started}ms`,
    );

  try {
    if (github.isGitPath(url.pathname)) {
      const out = await github.serveGit({
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        params: {},
        raw: body,
        json: undefined,
      });

      res.writeHead(out.status, out.headers).end(out.body);
      done(out.status);
      return;
    }

    if (await route(req, res, body)) {
      done(res.statusCode);
      return;
    }

    res
      .writeHead(404, { "content-type": "application/json" })
      .end('{"message":"no such stub route"}');

    done(404);
  } catch (e) {
    log(`error ${req.method} ${url.pathname}: ${e instanceof Error ? e.stack : String(e)}`);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
    }

    res.end(JSON.stringify({ message: e instanceof Error ? e.message : String(e) }));
    done(500);
  }
}

createHttp((req, res) => void handle(req, res)).listen(
  Number(process.env["STUB_HTTP_PORT"] ?? 8081),
);

createHttps(
  { cert: readFileSync(env("STUB_TLS_CERT")), key: readFileSync(env("STUB_TLS_KEY")) },
  (req, res) => void handle(req, res),
).listen(Number(process.env["STUB_HTTPS_PORT"] ?? 443));

log("stubs ready");
