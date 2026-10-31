import { readFileSync } from "node:fs";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import {
  createRouter,
  incomingFromNode,
  readBody,
  writeReply,
  type Incoming,
  type StandInReply,
} from "@outstaff/testing.http";
import { BareRepo, createGithubE2e } from "@outstaff/testing.github/stand-in";
import { createItsaplanE2e } from "@outstaff/testing.itsaplan/stand-in";
import { createChat } from "./chat.ts";
import { controlRoutes, serviceRoutes } from "./control.ts";

/**
 * The end-to-end test's stand-ins over HTTP: GitHub (API and git remote) and Its a Plan from the shared vendor
 * stand-ins (testing/github, testing/itsaplan), plus a chat workspace and two team services. Configuration comes
 * from the environment so the same file runs in a container and on a laptop:
 *
 *   STUB_DATA_DIR      where the bare repository lives
 *   STUB_APPS          `<app id>=<slug>,...` the GitHub Apps that exist
 *   STUB_APP_PUBLIC_KEY  PEM file; Apps must sign their JWTs with the matching private key
 *   STUB_TRACKER_KEYS  `<api key>=<username>,...`
 *   STUB_HOME_TOKEN    the bearer token the home service (home.acme.example) wants
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

// A second repository of the team, so that an agent can write to two.
const ops = new BareRepo(env("STUB_DATA_DIR"), "acme", "ops");
await ops.init({ "README.md": "# Acme Ops\n" });

const github = createGithubE2e({
  repo,
  more: [ops],
  apps: pairs(env("STUB_APPS")),
  publicKey: readFileSync(env("STUB_APP_PUBLIC_KEY"), "utf8"),
  permissions: { "ada-admin": "write", "grace-lead": "write" },
});

const tracker = createItsaplanE2e({
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
    { userId: "u-pia", name: "Pia Novak", username: "pia", kind: "agent" },
  ],
  keys: Object.fromEntries(
    Object.entries(pairs(env("STUB_TRACKER_KEYS"))).map(([k, user]) => [k, `u-${user}`]),
  ),
  human: "ada.admin",
});

const chat = createChat();
const dispatch = createRouter([
  ...controlRoutes({ repo, github, tracker, chat }),
  ...serviceRoutes(env("STUB_HOME_TOKEN")),
  ...chat.routes,
  ...github.routes,
  ...tracker.routes,
]);

const NOT_FOUND: StandInReply = { status: 404, body: { message: "no such stub route" } };

/** The answer of the git server, a stand-in route or a 404. */
async function answer(incoming: Incoming): Promise<StandInReply> {
  if (github.isGitPath(incoming.path)) {
    return github.serveGit(incoming);
  }

  return (await dispatch(incoming))?.reply ?? NOT_FOUND;
}

/** The request as the stand-ins see it, or a 400 for a JSON body that does not parse. */
async function incomingOf(req: IncomingMessage): Promise<Incoming | StandInReply> {
  const raw = await readBody(req);
  try {
    return await incomingFromNode(req, raw);
  } catch (e) {
    if (e instanceof SyntaxError) {
      return { status: 400, body: { message: "bad json" } };
    }

    throw e;
  }
}

async function respond(req: IncomingMessage): Promise<StandInReply> {
  const incoming = await incomingOf(req);
  return "path" in incoming ? answer(incoming) : incoming;
}

function fail(req: IncomingMessage, url: URL, e: unknown): StandInReply {
  log(`error ${req.method} ${url.pathname}: ${e instanceof Error ? e.stack : String(e)}`);
  return { status: 500, body: { message: e instanceof Error ? e.message : String(e) } };
}

/** The request line for the access log: method, path and the start of the query. */
const requestLine = (req: IncomingMessage, url: URL) =>
  `${req.method} ${url.pathname}${url.search ? "?" : ""}${url.searchParams.size ? url.search.slice(1, 80) : ""}`;

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const url = new URL(req.url ?? "/", "http://stub");
  const reply = await respond(req).catch((e: unknown) => fail(req, url, e));
  writeReply(res, reply);
  log(`${requestLine(req, url)} ${reply.status ?? 200} ${Date.now() - started}ms`);
}

createHttp((req, res) => void handle(req, res)).listen(
  Number(process.env["STUB_HTTP_PORT"] ?? 8081),
);

createHttps(
  { cert: readFileSync(env("STUB_TLS_CERT")), key: readFileSync(env("STUB_TLS_KEY")) },
  (req, res) => void handle(req, res),
).listen(Number(process.env["STUB_HTTPS_PORT"] ?? 443));

log("stubs ready");
