// The acme loop end to end, on Docker Compose: a ticket is assigned, the agent clones, commits and opens a pull
// request, a human asks for changes while another asks a question in chat (answered by a chat session before the round ends), the agent fixes and resolves the thread, a review with only a summary gets a
// pull request comment, a batch review with two inline comments gets a reply in each thread, a short "yes" to the agent's own earlier comment is answered from the conversation, the human merges, a
// second pull request now conflicts and the agent rebases it and pushes with a lease, and a comment on the merged pull
// request gets a reply and a follow-up pull request (for a sub-ticket of its own), and a ticket that needs two pull
// requests is split into a sub-ticket first, so that each ticket has one (merging the first closes only its own
// ticket), and an approval by the merge approver wakes the author to decide the merge, which joins the merge queue, the host merges it and the ticket is done, and of two approved pull requests that change the same file the older merges first while the other waits, is rebased and merges after, and a direct message with a picture is answered and its ticket gets the picture, a comment on an agent's design document and one on a handed-back ticket reach the agent, a blocked ticket goes to the PM, who unblocks it (the agent resumes) or hands it to the human saying what is needed, an answer the PM posts on such a ticket later wakes the agent blocked on it, a mention of the agent on a blocked ticket held by a human makes the ticket the agent's, and a ticket the agent assigned to itself is started by the office once the agent is idle, and a ticket the PM files from chat for the developer is the developer's from the start. The office, Postgres and the agent are the real images; GitHub,
// the tracker and the model are stand-ins (e2e/stubs, e2e/runtime-scripted); the PM, pia, runs on the same agent image.
//
//   node e2e/run.ts
//
// E2E_PREBUILT=1   use the images that are already tagged (outstaff/{office,agent-e2e,e2e-stubs}:local)
// E2E_KEEP=1       leave the stack and its files up after the run, for a look around
// E2E_TIMEOUT_MS   bound of the whole run (default 600000)
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const compose = join(here, "compose.e2e.yaml");
const cli = join(root, "packages/cli/dist/cli.js");

const started = Date.now();
const deadline = started + Number(process.env["E2E_TIMEOUT_MS"] ?? 600_000);
const project = `outstaff-e2e-${process.pid}`;
const port = process.env["E2E_STUB_PORT"] ?? String(18_000 + (process.pid % 1000));
const officePort = process.env["E2E_OFFICE_HEALTH_PORT"] ?? String(19_000 + (process.pid % 1000));
const work = mkdtempSync(join(tmpdir(), "outstaff-e2e-"));
chmodSync(work, 0o755);

const timings: [string, number][] = [];
let last = started;
const log = (line: string) =>
  process.stdout.write(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${line}\n`);

const step = (name: string) => {
  const now = Date.now();
  timings.push([name, now - last]);
  last = now;
  log(`ok   ${name}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the world the stack runs in

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

const stub = async (method: string, path: string, body?: unknown): Promise<Json> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as Json;
};

const state = () => stub("GET", "/_test/state");

/** The office's health answer, whose `components.intake.polls` counts each source's successful polls. */
const officeHealth = async (): Promise<Json> =>
  (await fetch(`http://127.0.0.1:${officePort}/healthz`)).json() as Promise<Json>;

/**
 * Reads with `read` until `check` returns a value that is not undefined or false; the failure says what was waited
 * for and shows what was read last.
 */
async function waitFor<T>(
  what: string,
  read: () => Promise<Json>,
  check: (s: Json) => T | undefined | false,
  ms = 150_000,
): Promise<T> {
  const limit = Math.min(Date.now() + ms, deadline);
  let s: Json = {};
  while (Date.now() < limit) {
    s = await read();
    const hit = check(s);
    if (hit !== undefined && hit !== false) {
      return hit;
    }

    await sleep(300);
  }

  throw new Error(`Timed out waiting for: ${what}\nlast read: ${JSON.stringify(s, null, 2)}`);
}

/** Polls the stubs until `check` holds. */
const until = <T>(what: string, check: (s: Json) => T | undefined | false, ms?: number) =>
  waitFor(what, state, check, ms);

/** The successful polls of each source the office polls, from its health answer. */
const pollCounts = (h: Json): Record<string, number> =>
  Object.fromEntries(
    Object.entries(h.components.intake.polls as Record<string, { count: number }>).map(
      ([source, p]) => [source, p.count],
    ),
  );

/** Whether the agent's chat profile for the trusted human says it is idle. */
/** How many notes of a done hand-back sam posted on the ticket; the note comes after the move and the assignment. */
const handBackNotes = (t: Json): number =>
  t.comments.filter(
    (c: Json) => c.author === "sam" && c.body.includes("I handed the work back as done."),
  ).length;

const idle = (s: Json) =>
  s.chat.profiles.findLast((p: Json) => p.agent === "sam" && p.userId === "U0ADA00001")?.profile
    .status === "idle";

/**
 * Waits until every source the office polls has had two more successful polls. A poll in flight now may have begun
 * before what just happened; the one after it began later, and a poll ends only once the events it read were
 * handled. So whatever happened before this call has been seen and judged by the office: the evidence a negative
 * check needs, instead of a fixed sleep.
 */
async function officePolledTwice(what: string) {
  const before = pollCounts(await officeHealth());
  await waitFor(`two office polls of every source since ${what}`, officeHealth, (h) =>
    Object.entries(before).every(([source, n]) => (pollCounts(h)[source] ?? 0) >= n + 2),
  );
}

const dc = (...args: string[]) =>
  spawnSync("docker", ["compose", "-p", project, "-f", compose, ...args], {
    env: composeEnv,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 256 * 1024 * 1024,
  });

const buildImage = (target: string, tag: string) =>
  spawnSync(
    "docker",
    ["build", "-f", join(root, "images/Dockerfile"), "--target", target, "-t", tag, root],
    { encoding: "utf8", timeout: 900_000, maxBuffer: 256 * 1024 * 1024 },
  );

const logs = (service: string) => dc("logs", "--no-color", "--no-log-prefix", service).stdout;

let composeEnv: NodeJS.ProcessEnv = process.env;

function fail(e: unknown): never {
  process.stderr.write(`\nFAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  for (const service of ["stubs", "office", "sam", "pia"]) {
    process.stderr.write(
      `\n---------------- ${service} log (tail)\n${logs(service).split("\n").slice(-120).join("\n")}\n`,
    );
  }

  return teardown(1);
}

function teardown(code: number): never {
  if (process.env["E2E_KEEP"] === "1") {
    log(`left running: project ${project}, files in ${work}, stub at http://127.0.0.1:${port}`);
  } else {
    dc("down", "-v", "--remove-orphans");
    rmSync(work, { recursive: true, force: true });
  }

  process.exit(code);
}

// A killed run takes down its own compose project (and only that one) instead of leaving the stack behind.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => teardown(128));
}

// ---------------------------------------------------------------- inputs: keys, certificates, team, secrets

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o644);
}

const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "pipe" });

/** A throwaway key for the GitHub Apps and a CA with a certificate for the stub's host name (git needs https). */
function prepareKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const tls = join(work, "tls");
  mkdirSync(tls, { recursive: true });
  chmodSync(tls, 0o755);
  write(join(tls, "app.pub"), publicKey);
  const ca = ["-keyout", join(tls, "ca.key"), "-out", join(tls, "ca.pem")];
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    ...ca,
    "-days",
    "2",
    "-subj",
    "/CN=outstaff-e2e-ca",
  );

  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(tls, "server.key"),
    "-out",
    join(tls, "server.csr"),
    "-subj",
    "/CN=github.acme.example",
  );

  write(join(tls, "ext.cnf"), "subjectAltName=DNS:github.acme.example\n");
  openssl(
    "x509",
    "-req",
    "-in",
    join(tls, "server.csr"),
    "-CA",
    join(tls, "ca.pem"),
    "-CAkey",
    join(tls, "ca.key"),
    "-CAcreateserial",
    "-out",
    join(tls, "server.pem"),
    "-days",
    "2",
    "-extfile",
    join(tls, "ext.cnf"),
  );

  rmSync(join(tls, "ca.key"));
  for (const f of ["server.key", "server.pem", "ca.pem"]) {
    chmodSync(join(tls, f), 0o644);
  }

  return privateKey;
}

/** The bearer token of the stub's home service: sam's secret, which the agent must never see. */
const homeToken = randomBytes(12).toString("hex");

function prepareSecrets(privateKey: string, keys: { office: string; sam: string; pia: string }) {
  const s = join(work, "secrets");
  const token = randomBytes(24).toString("hex");
  write(join(s, "office/GH_OFFICE_APP_ID"), "100");
  write(join(s, "office/GH_OFFICE_APP_PRIVATE_KEY"), privateKey);
  write(join(s, "office/ITSAPLAN_API_KEY"), keys.office);
  write(join(s, "office/SLACK_OFFICE_BOT_TOKEN"), "dummy-not-used");
  write(join(s, "sam/OUTSTAFF_AGENT_TOKEN"), token);
  write(join(s, "office/OUTSTAFF_AGENT_TOKEN_MIRA"), randomBytes(24).toString("hex"));
  write(join(s, "office/OUTSTAFF_AGENT_TOKEN_PIA"), randomBytes(24).toString("hex"));
  write(join(s, "sam/GH_APP_ID"), "201");
  write(join(s, "sam/GH_APP_PRIVATE_KEY"), privateKey);
  write(join(s, "sam/ITSAPLAN_API_KEY"), keys.sam);
  write(join(s, "sam/E2E_HOME_TOKEN"), homeToken);
  write(join(s, "pia/ITSAPLAN_API_KEY"), keys.pia);
}

const TEAM = `version: 1
team: { name: acme, product: Acme Shop }
humans:
  - name: Ada Admin
    identities: { vcs: ada-admin, tracker: ada.admin, chat: U0ADA00001 }
  - name: Grace Lead
    identities: { vcs: grace-lead }
  - name: Mona Merge
    identities: { vcs: merge-approver }
catalog: { version: 0.0.0 }
repos:
  - { name: shop, url: github.acme.example/acme/shop, kind: primary }
  - { name: ops, url: github.acme.example/acme/ops, kind: infra }
people: []
integrations:
  chat: { adapter: slack }
  vcs:
    adapter: github
    apiUrl: http://github.acme.example:8081/api/v3
    webUrl: https://github.acme.example
  # The team's default runtime; sam runs on the scripted one of their own (people[].runtime), which only this
  # image carries, so the agent picking it proves the per-person choice.
  runtime: { adapter: claude-agent-sdk }
  tracker:
    adapter: itsaplan
    url: http://tracker.acme.example:8081/tracker
    api_url: http://tracker.acme.example:8081/tracker
    project: SHOP
  knowledge: { adapter: itsaplan }
workflow:
  statuses:
    backlog: Backlog
    ready: Ready
    active: In Progress
    review: In Review
    blocked: Blocked
    done: Done
    canceled: Canceled
office:
  events: poll
  poll_interval_seconds: 10
  # Slack has dummy tokens and no stand-in, so the office's doctor does not call it.
  doctor: { skip: [chat] }
# Each event wakes the agent at once: the run waits for every step, and a batch of comments arrives as one review.
pipeline:
  wake: { coalesce_seconds: 0 }
policies:
  # Only this approver's approval wakes an author to merge: the other steps approve nothing, and a human here changes
  # none of them. The stub's ruleset needs one approval and its merge queue merges what joins it.
  merge: { on_approval: true, approvers: [human:merge-approver] }
`;

/**
 * The hires are `ost hire`, the real command, against a team file in a temp directory. It leaves the platform
 * identities for the person to fill in (the next step of its own checklist), so they are added to the file here.
 */
function hire() {
  const dir = join(work, "team");
  const file = join(dir, ".outstaff/team.yaml");
  write(file, TEAM);
  for (const p of [
    {
      role: "developer",
      handle: "sam",
      name: "Sam Duarte",
      pronouns: "they/them",
      model: "sonnet",
    },
    { role: "architect", handle: "mira", name: "Mira Okafor", pronouns: "she/her", model: "opus" },
    // The PM has no repositories: it works on tickets only, here to unblock what sam hands back as blocked.
    {
      role: "pm",
      handle: "pia",
      name: "Pia Novak",
      pronouns: "she/her",
      model: "sonnet",
      repos: false,
    },
  ]) {
    const out = spawnSync(
      "node",
      [
        cli,
        "hire",
        p.role,
        "--name",
        p.name,
        "--handle",
        p.handle,
        "--pronouns",
        p.pronouns,
        "--model",
        p.model,
        ...(p.repos === false ? [] : ["--repos", "shop=write,ops=write"]),
        "--yes",
        "--out",
        dir,
      ],
      { cwd: dir, encoding: "utf8" },
    );

    if (out.status !== 0) {
      throw new Error(`ost hire ${p.role} failed:\n${out.stdout}${out.stderr}`);
    }

    const text = readFileSync(file, "utf8");
    // Sam runs on the scripted runtime and may also reach the stub's two services: the hub with no authentication,
    // the home service with a token. Pia, the PM, runs on the scripted runtime too.
    const network =
      p.handle === "sam"
        ? `    runtime: { adapter: scripted }\n    network:\n      http:\n        - { name: hub, url: "http://hub.acme.example:8081" }\n        - { name: home, url: "http://home.acme.example:8081", token: E2E_HOME_TOKEN }\n`
        : p.handle === "pia"
          ? "    runtime: { adapter: scripted }\n"
          : "";

    const patched = text.replace(
      new RegExp(`(\\n {4}role: ${p.role}\\n)`),
      `$1    identities:\n      vcs: acme-${p.handle}[bot]\n      tracker: ${p.handle}\n${network}`,
    );

    if (patched === text) {
      throw new Error(`ost hire did not produce the expected entry for ${p.handle}:\n${text}`);
    }

    writeFileSync(file, patched);
  }

  write(join(dir, "team.yaml"), readFileSync(file, "utf8"));
  const check = spawnSync("node", [cli, "validate"], { cwd: dir, encoding: "utf8" });
  if (check.status !== 0) {
    throw new Error(`The team file does not validate:\n${check.stdout}${check.stderr}`);
  }
}

// ---------------------------------------------------------------- the run

/** The image of each Dockerfile target the stack runs. The tags are the defaults of compose.e2e.yaml. */
const IMAGES = [
  ["office", "outstaff/office:local"],
  ["agent-e2e", "outstaff/agent-e2e:local"],
  ["e2e-stubs", "outstaff/e2e-stubs:local"],
] as const;

/** Builds one image. Docker Hub answers the frontend lookup with a gateway error now and then; a build is worth a retry. */
async function buildWithRetry(target: string, tag: string) {
  let build = buildImage(target, tag);
  for (let attempt = 1; build.status !== 0 && attempt < 3; attempt++) {
    await sleep(5_000);
    build = buildImage(target, tag);
  }

  if (build.status !== 0) {
    throw new Error(`The ${target} image did not build:\n${build.stdout}${build.stderr}`);
  }
}

async function buildImages() {
  if (process.env["E2E_PREBUILT"] === "1") {
    return;
  }

  for (const [target, tag] of IMAGES) {
    await buildWithRetry(target, tag);
  }

  step("images: built office, agent-e2e and stubs");
}

/** Runs a compose command; fails with `what` and the command's output when it does not succeed. */
function dcOrFail(what: string, ...args: string[]) {
  const out = dc(...args);
  if (out.status !== 0) {
    throw new Error(`${what}:\n${out.stdout}${out.stderr}`);
  }
}

/** The kind of each wake the office queued, or folded into an open item, for a person, in order: from its log. */
const wakesOf = (person: string) =>
  [
    ...logs("office").matchAll(
      new RegExp(
        `pipeline: (?:queued|folded the wake into) work item \\S+ for ${person} \\((\\w+)\\)`,
        "g",
      ),
    ),
  ].map((m) => m[1]);

const piaWakes = () => wakesOf("pia");

const connected = (person: string) =>
  new RegExp(`"agent connected","person":"${person}"`).test(logs("office"));

/** Waits until the agent connects to the office and picks its own runtime. */
async function awaitAgent(person: string) {
  for (let i = 0; i < 60 && !connected(person); i++) {
    await sleep(1_000);
  }

  if (!connected(person)) {
    throw new Error(`${person} never connected to the office.`);
  }

  // The agent connects before it prepares (the team comes from the office), so the runtime is picked a moment later.
  const selected = () =>
    new RegExp(`runtime selected {"person":"${person}","runtime":"scripted"`).test(logs(person));

  for (let i = 0; i < 120 && !selected(); i++) {
    await sleep(1_000);
  }

  if (!selected()) {
    throw new Error(`${person} did not start on its own runtime (people[].runtime: scripted).`);
  }
}

/** Brings up the stubs and the office, then the agents, and waits until they connect to the office. */
async function startStack() {
  const healthy = ["--wait", "--wait-timeout", "240"];
  dcOrFail("The stack did not come up", "up", "-d", ...healthy, "stubs", "office");
  step("stack: stubs, Postgres and the office are healthy");
  dcOrFail("The agents did not start", "up", "-d", "--no-deps", "sam", "pia");
  await awaitAgent("sam");
  await awaitAgent("pia");
  step("agents: sam and pia connected to the office, each on its own runtime");
}

async function main() {
  hire();
  step("hire: ost hire developer sam, architect mira and pm pia, team file validates");

  const privateKey = prepareKeys();
  const keys = {
    office: randomBytes(12).toString("hex"),
    sam: randomBytes(12).toString("hex"),
    pia: randomBytes(12).toString("hex"),
  };

  prepareSecrets(privateKey, keys);
  composeEnv = {
    ...process.env,
    E2E_DIR: work,
    E2E_PROJECT: project,
    E2E_STUB_PORT: port,
    E2E_OFFICE_HEALTH_PORT: officePort,
    POSTGRES_PASSWORD: randomBytes(12).toString("hex"),
    STUB_APPS: "100=acme-office,201=acme-sam",
    STUB_TRACKER_KEYS: `${keys.office}=office,${keys.sam}=sam,${keys.pia}=pia`,
    STUB_HOME_TOKEN: homeToken,
  };

  await buildImages();
  await startStack();

  // ---- 1. a human assigns a ticket; the office schedules it; the agent clones, commits, pushes, opens a pull request
  const { key: first } = await stub("POST", "/_test/tickets", { title: "Add a greeting" });
  await stub("POST", `/_test/tickets/${first}/assign`, { to: "sam" });
  // The hand-back moves the ticket, then reassigns it: wait for both, not just the move.
  const pr1 = await until(
    "a pull request for the first ticket, ticket in review and handed back",
    (s) => {
      const pr = s.github.pulls.find((p: Json) => p.body.includes(`Closes ${first}`));
      const t = s.tickets.find((x: Json) => x.key === first);
      return pr && t.status === "In Review" && t.assignee !== "sam" ? { pr, t } : undefined;
    },
  );

  assertEq(pr1.pr.author, "acme-sam[bot]", "the pull request is opened by the agent's own App");
  assertEq(pr1.pr.state, "open", "the pull request is open");
  assertEq(pr1.t.assignee, "ada.admin", "the ticket went back to the human who asked");
  assertEq(
    pr1.pr.head.ref,
    `feat/${first}-add-a-greeting`,
    "the repository names no branch format: the agent named the branch by the default <type>/<key>-<slug>",
  );

  const moved = pr1.t.moves.map((m: Json) => `${m.from}>${m.to}`);
  assertIncludes(
    moved,
    "Ready>In Progress",
    "the office moved the ticket to active for sam when the work started",
  );

  assertIncludes(moved, "In Progress>In Review", "the ticket went to review");
  const linked = await until("the pull request linked on its ticket in the tracker", (s) => {
    const t = s.tickets.find((x: Json) => x.key === first);
    return t.development.length > 0 ? t.development : undefined;
  });

  assertEq(
    JSON.stringify(linked),
    JSON.stringify([{ repository: "acme/shop", number: pr1.pr.number, by: "sam" }]),
    "the agent linked its pull request on the ticket, with its own tracker account",
  );

  step(
    `assignment: ${first} -> sam cloned, committed, pushed and opened pull request #${pr1.pr.number}; ticket in review`,
  );

  // ---- 2. the same for a second ticket, which also asks the architect; its pull request edits the same line
  const { key: second } = await stub("POST", "/_test/tickets", {
    title: "Add a second greeting",
    description:
      "Greet the shop's second visitor.\n\nask architect: Should greetings be one file or one per visitor?",
  });

  await stub("POST", `/_test/tickets/${second}/assign`, { to: "sam" });
  const pr2 = await until(
    "a pull request for the second ticket and the question on the ticket",
    (s) => {
      const pr = s.github.pulls.find((p: Json) => p.body.includes(`Closes ${second}`));
      const t = s.tickets.find((x: Json) => x.key === second);
      const asked = t.comments.find((c: Json) => c.body.includes("Should greetings be one file"));
      return pr && asked ? { pr, t, asked } : undefined;
    },
  );

  step(
    `ask: ${second} opened pull request #${pr2.pr.number}; the question to the architect is mirrored on the ticket`,
  );

  // ---- 3. a human asks for changes; the ticket goes back to the author, who fixes, replies and resolves.
  // The round is held at a gate, and a human asks a question in chat meanwhile: it is answered by a chat session
  // beside the round, before the round ends.
  const before = pr1.pr.head.sha;
  await stub("POST", "/_test/gates/review/close");
  await stub("POST", `/_test/pulls/${pr1.pr.number}/review`, {
    state: "changes_requested",
    body: "Please greet properly.\n\nfollow-up: Add a farewell",
    comments: [{ path: "greeting.txt", line: 1, body: "Say hello to someone." }],
  });

  await until("the review round running and held at the gate", (s) => s.chat.gates.review?.arrived);

  // The agent publishes its profile for the trusted human while the round runs: working on the ticket, linked.
  const published = await until("a chat profile with the active item", (s) =>
    s.chat.profiles.findLast(
      (p: Json) =>
        p.agent === "sam" &&
        p.userId === "U0ADA00001" &&
        p.profile.status === "working" &&
        p.profile.current?.title.includes(first),
    ),
  );

  assertEq(
    published.profile.sections[0].lines.some((l: string) => l.includes(first)),
    true,
    "the profile lists the current work, grouped by ticket",
  );

  step(`profile: published for the trusted human while the review round runs, working on ${first}`);

  const asked = await stub("POST", "/_test/chat/say", { text: "Where do the greetings live?" });
  const reply = await until("an answer in chat while the review round is held", (s) =>
    s.chat.posts.find((p: Json) => p.thread === asked.id),
  );

  const during = await state();
  assertIncludes([reply.text], reply.text, "the question was answered");
  assertEq(reply.text.includes("greeting.txt"), true, "the answer is about the greetings");
  assertEq(reply.text.includes("busy"), false, "no busy reply, no placement question");
  assertEq(
    during.chat.posts.filter((p: Json) => p.thread === asked.id).length,
    1,
    "one post in the thread, the answer",
  );

  assertEq(
    during.github.pulls.find((p: Json) => p.number === pr1.pr.number).head.sha,
    before,
    "the review round has not pushed yet",
  );

  assertEq(
    during.tickets.find((x: Json) => x.key === first).status,
    "In Progress",
    "the round is still running when the answer comes",
  );

  assertEq(during.tickets.length, 2, "the question filed no ticket");

  step(
    "chat: a question asked while the review round is held is answered right away, with no ticket and no queue",
  );

  // A chat session reads the pull request and its checks itself (ost pr status).
  const statusAsked = await stub("POST", "/_test/chat/say", {
    text: `What is the status of PR #${pr1.pr.number}?`,
  });

  const statusReply = await until("the pull request status answered in chat", (s) =>
    s.chat.posts.find((p: Json) => p.thread === statusAsked.id),
  );

  assertEq(
    statusReply.text.includes("State: open"),
    true,
    "the chat answer has the pull request state",
  );

  assertEq(statusReply.text.includes("Checks:"), true, "the chat answer has the checks");

  step("chat: a status question is answered with the pull request and its checks");

  // The hand-back after the round moves the ticket, assigns it and then posts its note: wait for all three.
  const notesBefore = handBackNotes(during.tickets.find((x: Json) => x.key === first));
  await stub("POST", "/_test/gates/review/open");

  const fixed = await until(
    "a fix pushed, the thread answered and resolved, the ticket back in review and handed back",
    (s) => {
      const pr = s.github.pulls.find((p: Json) => p.number === pr1.pr.number);
      const t = s.tickets.find((x: Json) => x.key === first);
      const thread = pr.threads[0];
      return pr.head.sha !== before &&
        thread?.resolved &&
        thread.comments.length > 1 &&
        t.status === "In Review" &&
        handBackNotes(t) > notesBefore
        ? { pr, t, thread, github: s.github }
        : undefined;
    },
  );

  // The reviewer, grace-lead, has no tracker identity: the ticket goes back to its earlier requester.
  assertEq(
    fixed.t.assignee,
    "ada.admin",
    "the hand-back after the review gave the ticket to the requester the tracker can assign",
  );

  const strays = Object.keys(fixed.github.branches).filter((b) => /^review[-_]feedback\//.test(b));

  assertEq(
    strays.length,
    0,
    "the review round pushed to the pull request's branch, no branch of its own",
  );

  // The agent filed the reviewer's follow-up itself: one ticket, in the backlog, unassigned, under the reviewed ticket.
  const farewells = (await state()).tickets.filter((x: Json) => x.title === "Add a farewell");

  assertEq(farewells.length, 1, "the review round filed the follow-up once");
  assertEq(farewells[0].status, "Backlog", "the follow-up is in the backlog");
  assertEq(farewells[0].assignee ?? null, null, "the follow-up is unassigned");
  assertEq(farewells[0].parent, first, "the follow-up has the reviewed ticket as its real parent");
  step(
    `follow-up: the review round filed ${farewells[0].key} itself, in the backlog, unassigned, under ${first}`,
  );

  assertEq(fixed.thread.comments.at(-1).author, "acme-sam[bot]", "the agent replied in the thread");
  const eyes = fixed.github.reactions.filter(
    (x: Json) => x.kind === "inline_comment" && x.commentId === fixed.thread.comments[0].databaseId,
  );

  assertEq(
    JSON.stringify(eyes.map((x: Json) => [x.user, x.content])),
    JSON.stringify([["acme-sam[bot]", "eyes"]]),
    "the agent reacted with eyes to the inline comment once",
  );

  assertEq(
    eyes[0].seq < fixed.thread.comments[1].seq,
    true,
    "the eyes reaction came before the agent's reply",
  );

  // The shop's CONTRIBUTING.md asks for one commit per pull request: the fix was amended and pushed with a lease.
  assertEq(fixed.pr.commits, 1, "the repository's rule is one commit: the fix was amended into it");
  assertEq(fixed.pr.forcePushes > 0, true, "the amended commit was pushed with a lease");
  const rounds = fixed.t.moves.map((m: Json) => `${m.from}>${m.to}`);
  assertIncludes(
    rounds,
    "In Review>In Progress",
    "the office made the ticket active for sam again when the review round started",
  );

  step(
    `review: changes requested on #${pr1.pr.number} -> ticket active again, fix pushed, thread replied and resolved, back in review`,
  );

  // ---- 3b. a review with only a summary: the agent answers it on the pull request before handing back
  const summary = "Also keep the greeting on one line.";
  const sha2 = fixed.pr.head.sha;
  await stub("POST", `/_test/pulls/${pr1.pr.number}/review`, {
    state: "commented",
    body: summary,
  });

  const answered = await until(
    "the summary-only review answered on the pull request, the ticket back in review",
    (s) => {
      const pr = s.github.pulls.find((p: Json) => p.number === pr1.pr.number);
      const t = s.tickets.find((x: Json) => x.key === first);
      const reply = pr.conversation.find((c: Json) => c.body.includes(summary));
      return reply && pr.head.sha !== sha2 && t.status === "In Review" ? { reply, pr } : undefined;
    },
  );

  assertEq(answered.reply.author, "acme-sam[bot]", "the agent replied on the pull request");
  step(
    `summary: a review with only a body on #${pr1.pr.number} -> answered with a pull request comment, back in review`,
  );

  // ---- 3c. a batch review with two inline comments: each thread gets a reply and is resolved, nothing on top level
  const sha3 = answered.pr.head.sha;
  const talked = answered.pr.conversation.length;
  await stub("POST", `/_test/pulls/${pr1.pr.number}/review`, {
    state: "changes_requested",
    comments: [
      { path: "greeting.txt", line: 1, body: "Use a comma after the greeting." },
      { path: "greeting.txt", line: 2, body: "End with an exclamation mark." },
    ],
  });

  const batch = await until(
    "both inline comments of the batch review answered and resolved, the ticket back in review",
    (s) => {
      const pr = s.github.pulls.find((p: Json) => p.number === pr1.pr.number);
      const t = s.tickets.find((x: Json) => x.key === first);
      const mine = pr.threads.filter((th: Json) => /comma|exclamation/.test(th.comments[0].body));
      return pr.head.sha !== sha3 &&
        mine.length === 2 &&
        mine.every((th: Json) => th.resolved && th.comments.length > 1) &&
        t.status === "In Review"
        ? { pr, mine }
        : undefined;
    },
  );

  for (const th of batch.mine) {
    assertEq(th.comments.at(-1).author, "acme-sam[bot]", "the agent replied in the thread");
  }

  assertEq(batch.pr.conversation.length, talked, "nothing was posted at the top level");
  step(
    `batch: two inline comments on #${pr1.pr.number} -> one round, both threads replied and resolved, no top-level comment`,
  );

  // ---- 3d. a short "yes" to the agent's own earlier comment: the round reads the conversation and acts on the proposal
  const proposal = "Proposal: print the greeting in capitals";
  const shaYes = batch.pr.head.sha;
  await stub("POST", `/_test/pulls/${pr1.pr.number}/comment`, {
    actor: "acme-sam[bot]",
    body: proposal,
  });

  await stub("POST", `/_test/pulls/${pr1.pr.number}/comment`, {
    body: "Yes, please do it.",
  });

  const agreed = await until(
    "the short yes answered with the proposal's change, which only the earlier comment names",
    (s) => {
      const pr = s.github.pulls.find((p: Json) => p.number === pr1.pr.number);
      const done = pr.conversation.find(
        (c: Json) => c.author === "acme-sam[bot]" && c.body.includes("Done as proposed:"),
      );

      return pr.head.sha !== shaYes && done ? { pr, done } : undefined;
    },
  );

  assertEq(
    agreed.done.body.includes("print the greeting in capitals"),
    true,
    "the reply names what the yes agreed to",
  );

  step(
    `conversation: "yes" on #${pr1.pr.number} -> the round read the agent's earlier proposal (${proposal}) and pushed it`,
  );

  // ---- 3e. a chat request about the open pull request: the agent asks first (it is in review), then adds it to that
  // pull request instead of creating a ticket
  const sha4 = agreed.pr.head.sha;
  const ticketsBefore = (await state()).tickets.length;
  const pullsBefore = (await state()).github.pulls.length;
  const wish = `For PR #${pr1.pr.number}, also say goodbye on the last line.`;
  const wished = await stub("POST", "/_test/chat/say", { text: wish });
  const question = await until(
    "the agent asking whether the request belongs to the pull request in review",
    (s) =>
      s.chat.posts.find(
        (p: Json) => p.thread === wished.id && /in review, or do it as a follow-up\?/.test(p.text),
      ),
  );

  assertEq(
    question.text.includes(`PR #${pr1.pr.number}`),
    true,
    "the question names the pull request",
  );

  const asleep = await state();
  assertEq(asleep.tickets.length, ticketsBefore, "nothing is filed before the human answers");
  assertEq(
    asleep.github.pulls.find((p: Json) => p.number === pr1.pr.number).head.sha,
    sha4,
    "nothing is pushed before the human answers",
  );

  await stub("POST", "/_test/chat/say", { text: "This PR.", thread: wished.id });
  const added = await until(
    "the request pushed to the pull request, with the first reply and the answer in the thread",
    (s) => {
      const pr = s.github.pulls.find((p: Json) => p.number === pr1.pr.number);
      const first = s.chat.posts.find(
        (p: Json) => p.thread === wished.id && p.text.startsWith("Adding this to"),
      );

      const note = pr.conversation.find((c: Json) =>
        c.body.includes("say goodbye on the last line"),
      );

      const done = s.chat.posts.find(
        (p: Json) => p.thread === wished.id && p.text.includes("Addressed") && p !== first,
      );

      return pr.head.sha !== sha4 && first && note && done ? { pr, first, done } : undefined;
    },
  );

  assertEq(
    added.first.text.includes(`PR #${pr1.pr.number}`),
    true,
    "the first reply links the pull request",
  );

  const kept = await state();
  assertEq(kept.tickets.length, ticketsBefore, "no new ticket was created");
  assertEq(kept.github.pulls.length, pullsBefore, "no new pull request was opened");
  step(
    `attach: a chat request about #${pr1.pr.number} in review -> asked first, then pushed to that pull request, no new ticket`,
  );

  // ---- 3e. replies in the thread of running work: a review round is held at the gate, and a request about it is
  // attached from a chat thread, which links the thread to the running round. A question in that thread is answered
  // by a chat session beside the round; an instruction is attached to the round and leads to one follow-up round.
  const sha5 = added.pr.head.sha;
  await until("the agent idle again after the attached round", (s) =>
    s.chat.profiles.findLast((p: Json) => p.agent === "sam" && p.userId === "U0ADA00001")?.profile
      .status === "idle"
      ? true
      : undefined,
  );

  const loose = "Keep the greeting short.";
  await stub("POST", "/_test/gates/review/close");
  await stub("POST", `/_test/pulls/${pr1.pr.number}/review`, { state: "commented", body: loose });
  await until(
    "the second review round running and held at the gate",
    (s) => s.chat.gates.review?.arrived,
  );

  const first3e = await stub("POST", "/_test/chat/say", {
    text: `For PR #${pr1.pr.number}, also add a farewell line.`,
  });

  await until("the agent asking about the pull request in review", (s) =>
    s.chat.posts.find((p: Json) => p.thread === first3e.id && /follow-up\?/.test(p.text)),
  );

  await stub("POST", "/_test/chat/say", { text: "This PR.", thread: first3e.id });
  const joined = await until("the request attached to the running round", (s) =>
    s.chat.posts.find((p: Json) => p.thread === first3e.id && p.text.startsWith("Adding this to")),
  );

  assertEq(
    joined.text.includes("I'll pick it up when the current round ends."),
    true,
    `the first reply says the running round picks it up later (${joined.text})`,
  );

  const posted = (s: Json) => s.chat.posts.filter((p: Json) => p.thread === first3e.id).length;
  const quiet = posted(await state());

  await stub("POST", "/_test/chat/say", {
    text: "Anything else on the greetings?",
    thread: first3e.id,
  });

  const spoken = await until("an answer in the thread of the running round", (s) =>
    posted(s) > quiet ? s.chat.posts.findLast((p: Json) => p.thread === first3e.id) : undefined,
  );

  assertEq(spoken.text.includes("greeting.txt"), true, "the question in the thread is answered");
  const held = await state();
  assertEq(
    held.github.pulls.find((p: Json) => p.number === pr1.pr.number).head.sha,
    sha5,
    "the round has not pushed when the answer comes",
  );

  assertEq(
    held.tickets.find((x: Json) => x.key === first).status,
    "In Progress",
    "the round is still running when the thread is answered",
  );

  const instruction = "Also end the greeting with a full stop.";
  const seen = posted(held);
  await stub("POST", "/_test/chat/say", { text: instruction, thread: first3e.id });
  const noted = await until("the instruction noted in the thread while the round runs", (s) =>
    posted(s) > seen ? s.chat.posts.findLast((p: Json) => p.thread === first3e.id) : undefined,
  );

  assertEq(
    noted.text.includes("I'll pick it up when the current round ends."),
    true,
    "the instruction is noted for the next round",
  );

  assertEq(
    (await state()).github.pulls.find((p: Json) => p.number === pr1.pr.number).head.sha,
    sha5,
    "the instruction did not interrupt the round",
  );

  step(
    "thread: a question in the thread of a running round is answered at once, an instruction is noted for the next round",
  );

  await stub("POST", "/_test/gates/review/open");
  const roundTwo = await until(
    "the follow-up round answered both requests on the pull request, the ticket back in review",
    (s) => {
      const pr = s.github.pulls.find((p: Json) => p.number === pr1.pr.number);
      const t = s.tickets.find((x: Json) => x.key === first);
      const notes = pr.conversation.filter((c: Json) => c.body.includes("end the greeting"));
      const results = s.chat.posts.filter(
        (p: Json) => p.thread === first3e.id && p.text.includes("Addressed"),
      );

      const farewell = pr.conversation.filter((c: Json) => c.body.includes("add a farewell line"));
      return pr.head.sha !== sha5 &&
        notes.length > 0 &&
        farewell.length > 0 &&
        results.length >= 2 &&
        t.status === "In Review"
        ? { pr, notes, results, tickets: s.tickets.length }
        : undefined;
    },
  );

  assertEq(
    roundTwo.results.length,
    2,
    "the agent posted the result of the running round and of its follow-up in the attached thread, once each",
  );

  assertEq(roundTwo.notes.length, 1, "the instruction was handled once, in one follow-up round");
  assertEq(
    roundTwo.pr.conversation.filter((c: Json) => c.body.includes("add a farewell line")).length,
    1,
    "the request attached earlier was handled once too, in the same follow-up round",
  );

  assertEq(roundTwo.tickets, ticketsBefore, "no ticket was created for the instruction");
  step(
    "thread: the instruction became one follow-up round after the running round, answered on the pull request",
  );

  // ---- 4. the human merges; the ticket is done; the other pull request now conflicts and the agent rebases it
  await stub("POST", `/_test/pulls/${pr1.pr.number}/merge`);
  await until(
    `${first} done`,
    (s) => s.tickets.find((x: Json) => x.key === first).status === "Done",
  );

  step(`merge: #${pr1.pr.number} merged -> ${first} is done`);

  const rebased = await until(`#${pr2.pr.number} rebased on main and pushed with a lease`, (s) => {
    const pr = s.github.pulls.find((p: Json) => p.number === pr2.pr.number);
    return pr.forcePushes > 0 && pr.containsMain && pr.mergeable === true ? pr : undefined;
  });

  assertEq(rebased.state, "open", "the rebased pull request is still open");
  step(
    `conflict: #${pr2.pr.number} conflicted with main -> follow-up item, rebased, force-pushed with a lease, merges cleanly`,
  );

  // ---- 5. a comment on the merged pull request: the agent replies and opens a follow-up from the default branch
  const note = "The greeting should also say goodbye.";
  await stub("POST", `/_test/pulls/${pr1.pr.number}/comment`, { body: note });
  const followed = await until(
    `#${pr1.pr.number} answered and a follow-up pull request opened`,
    (s) => {
      const merged = s.github.pulls.find((p: Json) => p.number === pr1.pr.number);
      const follow = s.github.pulls.find((p: Json) =>
        p.body.includes(`Follows up on #${pr1.pr.number},`),
      );

      const answer = merged.conversation.find(
        (c: Json) => c.author === "acme-sam[bot]" && c.body.includes(note),
      );

      const link = merged.conversation.find((c: Json) => c.body.includes("Follow-up:"));
      return answer && follow && link ? { answer, follow, link } : undefined;
    },
  );

  assertEq(
    followed.answer.author,
    "acme-sam[bot]",
    "the agent answered on the merged pull request",
  );

  assertEq(followed.follow.state, "open", "the follow-up pull request is open");
  assertEq(
    followed.link.body.endsWith(`/pull/${followed.follow.number}`),
    true,
    "the reply links the follow-up",
  );

  const afterFollowUp = await state();
  assertEq(
    afterFollowUp.tickets.find((x: Json) => x.key === first).status,
    "Done",
    "the merged pull request's ticket stays done",
  );

  step(
    `merged feedback: a comment on merged #${pr1.pr.number} -> answered, follow-up #${followed.follow.number} opened, ${first} still done`,
  );

  // ---- 6. a ticket created already assigned to the agent: one `created` item, no assignment item, and it still starts
  const { key: third } = await stub("POST", "/_test/tickets", {
    title: "Add a farewell",
    assignee: "sam",
  });

  const pr3 = await until(`a pull request for ${third}, created already assigned`, (s) => {
    const pr = s.github.pulls.find((p: Json) => p.body.includes(`Closes ${third}`));
    return pr ? { pr } : undefined;
  });

  step(
    `created assigned: ${third} created already assigned to sam -> pull request #${pr3.pr.number} follows`,
  );

  // ---- 7. a repository whose rules ask for added commits: the review fix is a new commit, nothing is rewritten
  await stub("POST", "/_test/repo/file", {
    path: "CONTRIBUTING.md",
    message: "Keep every commit",
    text: "# Contributing to Acme Shop\n\n## Commits\n\nReview feedback is answered with new commits on the branch. Do not rewrite pushed history.\n\n## Branches\n\nName branches `feature/<key>-<slug>`.\n",
  });

  const { key: fourth } = await stub("POST", "/_test/tickets", {
    title: "Add a greeting footer",
    assignee: "sam",
  });

  const pr4 = await until(`a pull request for ${fourth}`, (s) => {
    const pr = s.github.pulls.find((p: Json) => p.body.includes(`Closes ${fourth}`));
    const t = s.tickets.find((x: Json) => x.key === fourth);
    return pr && t.status === "In Review" && t.assignee !== "sam" ? { pr } : undefined;
  });

  assertEq(pr4.pr.commits, 1, "the pull request starts as one commit");
  assertEq(
    pr4.pr.head.ref,
    `feature/${fourth}-add-a-greeting-footer`,
    "the repository's CONTRIBUTING.md names branches feature/<key>-<slug>: the agent followed it",
  );

  await stub("POST", `/_test/pulls/${pr4.pr.number}/review`, {
    state: "changes_requested",
    comments: [{ path: "greeting.txt", line: 1, body: "Say it louder." }],
  });

  const added4 = await until(`a fix on #${pr4.pr.number} as a new commit`, (s) => {
    const pr = s.github.pulls.find((p: Json) => p.number === pr4.pr.number);
    const t = s.tickets.find((x: Json) => x.key === fourth);
    return pr.head.sha !== pr4.pr.head.sha && pr.threads[0]?.resolved && t.status === "In Review"
      ? pr
      : undefined;
  });

  assertEq(added4.commits, 2, "the repository's rule is to add commits: the fix is a new commit");
  assertEq(added4.forcePushes, 0, "nothing was rewritten");
  step(
    `conventions: ${fourth} in a repo that asks for added commits -> the fix on #${pr4.pr.number} is a new commit, no force push`,
  );

  // ---- 7b. the agent container restarts in the middle of a round: the round is handed back as interrupted, goes
  // first in the queue and resumes when the agent is back, with nothing moved or reassigned meanwhile
  await stub("POST", "/_test/gates/review/close");
  await stub("POST", `/_test/pulls/${pr4.pr.number}/review`, {
    state: "changes_requested",
    comments: [{ path: "greeting.txt", line: 1, body: "Add a comma." }],
  });

  await until("the review round running and held at the gate", (s) => s.chat.gates.review?.arrived);

  const beforeRestart = await state();
  const ticketBefore = beforeRestart.tickets.find((x: Json) => x.key === fourth);
  const restarted = dc("restart", "sam");
  if (restarted.status !== 0) {
    throw new Error(`could not restart the agent: ${restarted.stderr}`);
  }

  // The gate stays closed; closing it again only clears the arrival of the first run.
  await stub("POST", "/_test/gates/review/close");
  await until(
    "the interrupted round offered again after the restart and held at the gate",
    (s) => s.chat.gates.review?.arrived,
  );

  const resumed = await state();
  const ticketResumed = resumed.tickets.find((x: Json) => x.key === fourth);
  assertEq(
    JSON.stringify([ticketResumed.status, ticketResumed.assignee]),
    JSON.stringify([ticketBefore.status, ticketBefore.assignee]),
    "the interrupted round moved and reassigned nothing",
  );

  assertEq(
    resumed.github.pulls.find((p: Json) => p.number === pr4.pr.number).head.sha,
    added4.head.sha,
    "the round has not pushed while it was held",
  );

  await stub("POST", "/_test/gates/review/open");
  const finished4 = await until(
    `the resumed round fixed #${pr4.pr.number} and the ticket is back in review`,
    (s) => {
      const pr = s.github.pulls.find((p: Json) => p.number === pr4.pr.number);
      const t = s.tickets.find((x: Json) => x.key === fourth);
      return pr.head.sha !== added4.head.sha &&
        pr.threads.length > 1 &&
        pr.threads.every((th: Json) => th.resolved) &&
        t.status === "In Review"
        ? pr
        : undefined;
    },
  );

  assertEq(finished4.commits, 3, "the resumed round added one commit, no more");
  step(
    `restart: the agent restarted mid-round on #${pr4.pr.number} -> the round was interrupted, queued first, resumed and finished`,
  );

  // ---- 8. a ticket that needs two pull requests: the agent splits it first, then opens one pull request per ticket
  const pullsBeforeSplit = (await state()).github.pulls.length;
  const { key: parent } = await stub("POST", "/_test/tickets", {
    title: "Add a farewell page",
    description: "It takes two pull requests.\n\nsplit: Add a farewell footer",
    assignee: "sam",
  });

  const split = await until(
    "a sub-ticket, one pull request per ticket, both tickets in review",
    (s) => {
      const child = s.tickets.find((t: Json) => t.description.includes(`Part of ${parent}:`));
      const forParent = s.github.pulls.find((p: Json) => p.body.includes(`Closes ${parent}`));
      const forChild =
        child && s.github.pulls.find((p: Json) => p.body.includes(`Closes ${child.key}`));

      const t = s.tickets.find((x: Json) => x.key === parent);
      return forParent &&
        forChild &&
        t.status === "In Review" &&
        t.assignee !== "sam" &&
        child.status === "In Review"
        ? { child, forParent, forChild, t }
        : undefined;
    },
  );

  assertEq(split.child.assignee, "sam", "the sub-ticket is assigned to the agent who made it");
  assertEq(split.child.parent, parent, "the sub-ticket has its parent as a real parent");
  assertEq(JSON.stringify(split.child.links), "[]", "no relates link where the parent is real");

  assertEq(
    split.t.comments.some((c: Json) => c.body.includes(split.child.key)),
    true,
    "the parent says it was split, with the sub-ticket's key",
  );

  const afterSplit = await state();
  assertEq(
    afterSplit.github.pulls.length,
    pullsBeforeSplit + 2,
    "two pull requests, one per ticket: the second one for the parent was refused",
  );

  assertEq(
    afterSplit.github.pulls.filter((p: Json) => p.body.includes(`Closes ${parent}`)).length,
    1,
    "the parent has one pull request",
  );

  step(
    `split: ${parent} split into ${split.child.key} -> #${split.forParent.number} and #${split.forChild.number}, one pull request per ticket; a second for ${parent} refused`,
  );

  await stub("POST", `/_test/pulls/${split.forParent.number}/merge`);
  await until(
    `${parent} done`,
    (s) => s.tickets.find((x: Json) => x.key === parent).status === "Done",
  );

  assertEq(
    (await state()).tickets.find((x: Json) => x.key === split.child.key).status,
    "In Review",
    "merging the parent's pull request leaves the sub-ticket alone",
  );

  await stub("POST", `/_test/pulls/${split.forChild.number}/merge`);
  await until(
    `${split.child.key} done`,
    (s) => s.tickets.find((x: Json) => x.key === split.child.key).status === "Done",
  );

  step(
    `split merge: #${split.forParent.number} merged -> only ${parent} is done; #${split.forChild.number} merged -> ${split.child.key} is done`,
  );

  // ---- 9. a direct message with a picture: it is answered (it used to be dropped), the ticket it becomes gets the
  // picture, and the agent that works the ticket downloads the picture from the tracker.
  const picture =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  const shot = await stub("POST", "/_test/chat/say", {
    text: "The farewell page looks wrong.",
    files: [{ name: "screen.png", mimetype: "image/png", base64: picture }],
  });

  const withPicture = await until(
    "a ticket filed from the picture message, with the picture",
    (s) => s.tickets.find((t: Json) => t.attachments.length > 0),
  );

  assertEq(withPicture.attachments.length, 1, "one file attached");
  assertEq(withPicture.attachments[0].name, "screen.png", "the file keeps its name");
  assertEq(withPicture.attachments[0].mimetype, "image/png", "the file keeps its type");
  assertEq(withPicture.attachments[0].base64, picture, "the tracker got the picture's bytes");
  assertIncludes(
    [withPicture.description.includes("see the attached screenshot") ? "yes" : "no"],
    "yes",
    "the ticket refers to the picture",
  );

  assertEq(
    withPicture.description.includes(
      "Attached to this ticket, from the chat message:\n- screen.png",
    ),
    true,
    "the ticket lists the picture",
  );

  const afterShot = await state();
  assertEq(
    afterShot.chat.reactions.some((r: Json) => r.messageId === shot.id && r.name === "eyes"),
    true,
    "the message with the picture got the eyes reaction",
  );

  await until("the reply in the picture's thread", (s) =>
    s.chat.posts.find((p: Json) => p.thread === shot.id && p.text.includes(withPicture.key)),
  );

  await until("the agent downloading the ticket's picture to work from", (s) =>
    s.attachmentsServed.length > 0 ? s.attachmentsServed : undefined,
  );

  step(
    `chat files: a direct message with a picture was answered; ${withPicture.key} has the picture attached and the working agent downloaded it`,
  );

  // ---- 10. a done hand-back on a ticket the agent left blocked stays blocked. The team has a PM, so the office gives
  // it to pia, for sam, and wakes her to unblock it; a staging credential is not something she can answer, so she
  // gives it to the requester, saying exactly what is needed.
  const piaBefore10 = piaWakes().length;
  const { key: stuck } = await stub("POST", "/_test/tickets", {
    title: "Rotate the staging key",
    description: "blocked: the staging credentials are missing",
    assignee: "sam",
  });

  const blockedAt = await until(`${stuck} handed on to the requester by the PM`, (s) => {
    const t = s.tickets.find((x: Json) => x.key === stuck);
    const asked = t.comments.find(
      (c: Json) => c.author === "pia" && c.body.startsWith("Needs a human:"),
    );

    return t.status === "Blocked" && t.assignee === "ada.admin" && asked
      ? { t, asked, pulls: s.github.pulls.length }
      : undefined;
  });

  assertEq(
    blockedAt.t.comments.some(
      (c: Json) =>
        c.author === "sam" &&
        c.body.includes("assigned to the team's PM to unblock: I handed the work back as blocked"),
    ),
    true,
    "the office gave the blocked ticket to the PM, as sam, and said so on the ticket",
  );

  assertEq(
    blockedAt.asked.body.includes("the staging credentials are missing"),
    true,
    "the PM said exactly what is needed from the human",
  );

  await until("the agent idle", (s) =>
    s.chat.profiles.findLast((p: Json) => p.agent === "sam" && p.userId === "U0ADA00001")?.profile
      .status === "idle"
      ? true
      : undefined,
  );

  const stays = await state();
  assertEq(
    stays.tickets.find((x: Json) => x.key === stuck).status,
    "Blocked",
    "the ticket is still blocked, not moved to review",
  );

  assertEq(stays.github.pulls.length, blockedAt.pulls, "no pull request was opened for it");
  step(
    `blocked: ${stuck} left blocked by the agent, handed back as done -> stays Blocked, goes to the PM, who cannot unblock it and gives it to the requester with what is needed`,
  );

  // The act that gave the ticket to pia was made by sam, so the tracker reports "assigned to pia by sam". That is the
  // echo of the office's own act: it wakes no one, so pia ran one round for the hand-back, the unblock one.
  await officePolledTwice(`${stuck} went to the requester`);
  assertEq(
    JSON.stringify(piaWakes().slice(piaBefore10)),
    JSON.stringify(["unblock"]),
    "pia was woken once for the blocked hand-back, to unblock it, and not again by the assignment's echo",
  );

  step(`blocked: pia ran exactly one round for ${stuck}, the unblock`);

  // The team has a PM (policies.hand_back.blocked_notify: pm), so the blocked agent leaves telling the requester to
  // the PM, who does it on the ticket, and the office posts nothing.
  assertEq(
    stays.chat.posts.some((p: Json) => p.text.includes(stuck)),
    false,
    "no chat message about the blocked ticket: the office posts nothing, and the agent leaves it to the PM",
  );

  step(`blocked: no chat message was posted about ${stuck}`);

  // ---- 10, answered: the PM could not unblock this one and gave it to the human. The answer comes later, outside the
  // office, and the PM posts it on the ticket: an agent's comment, on a ticket the human holds, wakes sam, who is
  // blocked on it. The PM's own comments during her unblock round woke no one.
  const piaBeforeAnswer = piaWakes().length;
  const samBeforeAnswer = wakesOf("sam").length;
  const { key: waiting } = await stub("POST", "/_test/tickets", {
    title: "Ship the release notes",
    description: "blocked: the release date is not decided",
    assignee: "sam",
  });

  const withHuman = await until(`${waiting} handed on to the requester by the PM`, (s) => {
    const t = s.tickets.find((x: Json) => x.key === waiting);
    const asked = t.comments.some(
      (c: Json) => c.author === "pia" && c.body.startsWith("Needs a human:"),
    );

    return t.status === "Blocked" && t.assignee === "ada.admin" && asked ? t : undefined;
  });

  await until("the agent idle", (s) =>
    s.chat.profiles.findLast((p: Json) => p.agent === "sam" && p.userId === "U0ADA00001")?.profile
      .status === "idle"
      ? true
      : undefined,
  );

  await officePolledTwice(`${waiting} went to the requester`);
  const humanHeld = (await state()).tickets.find((x: Json) => x.key === waiting);
  assertEq(humanHeld.status, "Blocked", "the PM's own comments did not wake sam: still blocked");
  assertEq(humanHeld.moves.length, withHuman.moves.length, "nobody moved the ticket meanwhile");
  assertEq(
    JSON.stringify(wakesOf("sam").slice(samBeforeAnswer)),
    JSON.stringify(["assigned"]),
    "sam was woken once, for the assignment, and not by the PM's comments",
  );

  // The answer comes later than the PM's round: a comment within a second of an agent's round on the ticket is taken
  // as that round's own, since the tracker's clock and the office's may differ a little.
  await officePolledTwice(`${waiting}: the PM's round is well over`);
  const answer = "The release date is Friday.";
  await stub("POST", `/_test/tickets/${waiting}/comment`, { body: answer, as: "pia" });
  const woken = await until(`${waiting}: sam woken by the answer`, (s) => {
    const t = s.tickets.find((x: Json) => x.key === waiting);
    const noted = t.comments.some((c: Json) => c.author === "sam" && c.body === `Noted: ${answer}`);
    return noted && t.status === "In Review" ? t : undefined;
  });

  assertEq(
    woken.moves
      .slice(withHuman.moves.length)
      .filter((m: Json) => m.from === "Blocked" && m.to === "In Progress").length,
    1,
    "the answer's round made the blocked ticket active once",
  );

  await until("the agent idle", (s) =>
    s.chat.profiles.findLast((p: Json) => p.agent === "sam" && p.userId === "U0ADA00001")?.profile
      .status === "idle"
      ? true
      : undefined,
  );

  await officePolledTwice(`${waiting} answered`);
  assertEq(
    JSON.stringify(wakesOf("sam").slice(samBeforeAnswer)),
    JSON.stringify(["assigned", "ticket_comment"]),
    "the answer woke sam once, as a ticket comment",
  );

  assertEq(
    JSON.stringify(piaWakes().slice(piaBeforeAnswer)),
    JSON.stringify(["unblock"]),
    "pia was woken once, to unblock it, and not by her own answer",
  );

  step(
    `answered: ${waiting} blocked -> the PM gave it to the human -> the PM posted the answer -> sam, blocked on it, was woken and carried on`,
  );

  // ---- 10, unblocked: the PM can answer this blocker. She comments the answer and gives the ticket back to sam; the
  // assignment wakes sam, the office makes the ticket active for him, the wake carries her comment, and sam resumes
  // the work and hands it back as done.
  const piaBeforeUnblock = piaWakes().length;
  const { key: answerable } = await stub("POST", "/_test/tickets", {
    title: "Pick the greeting's tone",
    description: "blocked: the greeting's tone is not decided\npm knows: friendly",
    assignee: "sam",
  });

  const unblockedTicket = await until(
    `${answerable} unblocked by the PM and resumed by sam`,
    (s) => {
      const t = s.tickets.find((x: Json) => x.key === answerable);
      const by = (author: string, body: string) =>
        t.comments.some((c: Json) => c.author === author && c.body === body);

      return t.status === "In Review" &&
        t.assignee === "ada.admin" &&
        by("pia", "Unblocked: friendly") &&
        by("sam", "Resumed with: friendly")
        ? t
        : undefined;
    },
  );

  const unblockedMoves = unblockedTicket.moves.map((m: Json) => `${m.by}:${m.from}>${m.to}`);
  assertIncludes(unblockedMoves, "sam:In Progress>Blocked", "sam blocked the ticket");
  assertIncludes(
    unblockedMoves,
    "sam:Blocked>In Progress",
    "the office moved the unblocked ticket to active, as sam, when sam's round started",
  );

  assertEq(
    unblockedTicket.comments.some(
      (c: Json) => c.author === "pia" && c.body.startsWith("Needs a human:"),
    ),
    false,
    "the PM answered it herself, without the human",
  );

  await until("the agent idle", (s) =>
    s.chat.profiles.findLast((p: Json) => p.agent === "sam" && p.userId === "U0ADA00001")?.profile
      .status === "idle"
      ? true
      : undefined,
  );

  await officePolledTwice(`${answerable} went to review`);
  assertEq(
    JSON.stringify(piaWakes().slice(piaBeforeUnblock)),
    JSON.stringify(["unblock"]),
    "pia was woken once, to unblock this ticket, and not by the echo of the act that gave it to her",
  );

  step(
    `unblock: ${answerable} blocked -> pia answered it and gave it back to sam -> active again when sam's round started, sam resumed from her comment and handed it back`,
  );

  // ---- 10a. a ticket that asks for the services the team granted: the token is added and never shown
  const { key: network } = await stub("POST", "/_test/tickets", {
    title: "Check the devices on the hub",
    description: "network: check the services",
    assignee: "sam",
  });

  const checked = await until(`${network} commented with the network check`, (s) => {
    const t = s.tickets.find((x: Json) => x.key === network);
    return t.comments.find((c: Json) => c.body.includes("Network check:"));
  });

  for (const part of ['"devices":2', '"lights":"on"', "Bearer ***", "other refused"]) {
    assertEq(checked.body.includes(part), true, `the network check says ${part}`);
  }

  assertEq(checked.body.includes(homeToken), false, "the token never reaches the agent's words");
  const hits = (await stub("GET", "/_test/service-hits")) as unknown as {
    host: string;
    path: string;
    authorized: boolean;
  }[];

  assertEq(
    JSON.stringify(hits),
    JSON.stringify([
      { host: "hub.acme.example:8081", path: "/hub/status", authorized: false },
      { host: "home.acme.example:8081", path: "/hub/secure", authorized: true },
    ]),
    "the hub was called without a token, the home service with it, and the ungranted origin not at all",
  );

  await until("the agent idle", (s) =>
    s.chat.profiles.findLast((p: Json) => p.agent === "sam" && p.userId === "U0ADA00001")?.profile
      .status === "idle"
      ? true
      : undefined,
  );

  step(
    `network grants: ${network} -> sam called the granted hub and (with its token, never shown) the home service; an ungranted service was refused`,
  );

  // ---- 10b. a ticket that names no repository, for an agent that can write to two: it asks and waits
  const { key: unsure } = await stub("POST", "/_test/tickets", {
    title: "Require a single commit per pull request",
    description: "which repo: unclear",
    assignee: "sam",
  });

  const asks = await until(`${unsure} asked about its repository`, (s) => {
    const t = s.tickets.find((x: Json) => x.key === unsure);
    const question = t.comments.find((c: Json) => c.body.includes("Which repository is"));
    return question ? { t, asked: question, pulls: s.github.pulls.length } : undefined;
  });

  assertEq(asks.asked.body.includes("`shop`"), true, "the question names the first candidate");
  assertEq(asks.asked.body.includes("`ops`"), true, "the question names the second candidate");
  await until("the agent idle", (s) =>
    s.chat.profiles.findLast((p: Json) => p.agent === "sam" && p.userId === "U0ADA00001")?.profile
      .status === "idle"
      ? true
      : undefined,
  );

  const stillAsking = await state();
  const unsureTicket = stillAsking.tickets.find((x: Json) => x.key === unsure);
  assertEq(unsureTicket.status, "In Progress", "the ticket waits for the answer, not in review");
  assertEq(
    stillAsking.github.pulls.length,
    asks.pulls,
    "no pull request was opened in either repository",
  );

  step(
    `repository: ${unsure} names no repository and sam can write to two -> asked in the ticket, no pull request`,
  );

  // ---- 10c. idle pull (policies.pull_ready): a ticket the agent assigned to itself starts nothing by itself (the
  // agent caused the event); with nothing queued, the office starts it as soon as the poll brings the assignment. It names no repository, so the
  // round only asks, as above, and opens no pull request.
  const { key: own } = await stub("POST", "/_test/tickets", {
    title: "Require a linear history",
    description: "which repo: unclear",
    assignee: "sam",
    as: "sam",
  });

  const pulled = await until(`${own}, assigned to sam by sam, started by the office`, (s) => {
    const t = s.tickets.find((x: Json) => x.key === own);
    return t.status === "In Progress" && t.comments.some((c: Json) => c.body.includes(own))
      ? t
      : undefined;
  });

  assertEq(pulled.moves[0]?.from, "Ready", "the round started on the ticket while it was ready");
  step(
    `idle pull: ${own}, self-assigned in Ready -> the office started it at once while sam was idle`,
  );

  // ---- 11. a reply in the thread of a done item continues its ticket instead of filing a duplicate
  const ticketsBefore10 = (await state()).tickets.length;
  const pullsBefore10 = (await state()).github.pulls.length;
  const request = await stub("POST", "/_test/chat/say", {
    text: "New work: add a sign-off line",
  });

  const made = await until("the sign-off ticket in review with its pull request", (s) => {
    const t = s.tickets.find((x: Json) => x.title === "add a sign-off line");
    const pr = t ? s.github.pulls.find((p: Json) => p.body.includes(`Closes ${t.key}`)) : undefined;
    return t && pr && t.status === "In Review" && t.assignee !== "sam" ? { t, pr } : undefined;
  });

  await until("the agent idle", (s) =>
    s.chat.profiles.findLast((p: Json) => p.agent === "sam" && p.userId === "U0ADA00001")?.profile
      .status === "idle"
      ? true
      : undefined,
  );

  // The done hand-back sent the ticket to the requester; the reply must still attach to it, and the attached work
  // gives it back to the agent when it starts (held at the review gate to see that).
  await stub("POST", "/_test/gates/review/close");
  await stub("POST", "/_test/chat/say", {
    text: "Also make the sign-off lowercase.",
    thread: request.id,
  });

  await until(
    "the attached round started and held at the gate",
    (s) => s.chat.gates.review?.arrived,
  );

  const taken = await state();
  assertEq(
    taken.tickets.find((x: Json) => x.key === made.t.key).assignee,
    "sam",
    "the ticket is assigned to the agent again when the attached work starts",
  );

  await stub("POST", "/_test/gates/review/open");
  await until(
    "the attached round pushed to the same pull request, the ticket back in review",
    (s) => {
      const pr = s.github.pulls.find((p: Json) => p.number === made.pr.number);
      const t = s.tickets.find((x: Json) => x.key === made.t.key);
      return pr.head.sha !== made.pr.head.sha && t.status === "In Review" && t.assignee !== "sam"
        ? true
        : undefined;
    },
  );

  const after10 = await state();
  assertEq(after10.tickets.length, ticketsBefore10 + 1, "no second ticket was filed for the reply");
  assertEq(after10.github.pulls.length, pullsBefore10 + 1, "no second pull request was opened");
  step(
    `thread: a reply after the done hand-back of ${made.t.key} continued it, no duplicate ticket`,
  );

  // ---- 11. a design document an agent wrote: a human comments on it, and the agent updates it, replies and
  // resolves; its own reply starts nothing. Then a human comments on the handed-back ticket and it goes back.
  const { key: design } = await stub("POST", "/_test/tickets", {
    title: "Decide where the cart lives",
    description: "Write down the options.\n\ndoc: Cart design options",
  });

  await stub("POST", `/_test/tickets/${design}/assign`, { to: "sam" });
  const written = await until("the design document and the ticket handed back", (s) => {
    const doc = s.docs.find((d: Json) => d.title === "Cart design options");
    const t = s.tickets.find((x: Json) => x.key === design);
    return doc && t.status === "In Review" && t.assignee === "ada.admin" ? { doc, t } : undefined;
  });

  assertEq(written.doc.path, `design/${design}.md`, "the agent created the document at its path");
  await stub("POST", `/_test/docs/${written.doc.id}/comments`, {
    body: "Why keep the cart in the session?",
    quote: "Keep the cart in the session.",
  });

  const docAnswered = await until(
    "the comment on the document answered: the document updated, a reply, the thread resolved",
    (s) => {
      const doc = s.docs.find((d: Json) => d.id === written.doc.id);
      const root = doc.comments.find((c: Json) => c.parentId === null);
      const reply = doc.comments.find((c: Json) => c.parentId === root?.id && c.author === "sam");
      return root?.resolved && reply && doc.version > written.doc.version
        ? { doc, root, reply, t: s.tickets.find((x: Json) => x.key === design) }
        : undefined;
    },
  );

  assertEq(
    docAnswered.doc.body.includes("Revised after review: Why keep the cart in the session?"),
    true,
    "the document was updated with the change the comment asked for",
  );

  assertEq(
    docAnswered.t.status,
    "In Review",
    "answering a comment on a document leaves the ticket",
  );

  assertEq(docAnswered.t.assignee, "ada.admin", "...and its assignee alone");
  step(
    `doc comment: a comment on ${design}'s design document reached its author, who updated the document, replied and resolved the thread`,
  );

  // The agent's own reply is a comment on the document too; it must not start another round. Once the agent is idle,
  // two office polls show the reply was read and judged, and the agent is still idle after them.
  await until("the agent idle after the document comment", (s) => idle(s) || undefined);
  await officePolledTwice("the agent's reply on the document");
  const afterReply = await state();
  assertEq(idle(afterReply), true, "the agent is still idle after its own reply was read");
  const docQuiet = afterReply.docs.find((d: Json) => d.id === written.doc.id);
  assertEq(
    docQuiet.version,
    docAnswered.doc.version,
    "the agent's own reply started no second round",
  );

  assertEq(
    docQuiet.comments.filter((c: Json) => c.author === "sam").length,
    1,
    "one reply, not one per poll",
  );

  step("doc comment: the agent's own reply started nothing");

  await stub("POST", `/_test/tickets/${design}/comment`, {
    body: "Please also cover the mobile layout.",
  });

  const reactivated = await until(
    "the comment on the handed-back ticket answered and the ticket handed back again",
    (s) => {
      const t = s.tickets.find((x: Json) => x.key === design);
      const note = t.comments.find(
        (c: Json) => c.author === "sam" && c.body === "Noted: Please also cover the mobile layout.",
      );

      return note &&
        t.status === "In Review" &&
        t.assignee === "ada.admin" &&
        t.moves.some((m: Json) => m.from === "In Review" && m.to === "In Progress")
        ? t
        : undefined;
    },
  );

  assertEq(
    reactivated.moves.filter((m: Json) => m.from === "In Review" && m.to === "In Progress").length,
    1,
    "the comment reactivated the ticket once",
  );

  step(
    `ticket comment: a comment on the handed-back ${design} sent it back to its agent (active), who answered and handed it back`,
  );

  // ---- 10b2. the checks of an open pull request fail: its author gets a round with the failing check, whatever the
  // ticket's status, and hands the ticket back
  await stub("POST", `/_test/pulls/${pr2.pr.number}/check`, {
    name: "build",
    conclusion: "failure",
  });

  const ci = await until(`${second}: the failing build was looked at`, (s) => {
    const t = s.tickets.find((x: Json) => x.key === second);
    return t.comments.some((c: Json) => c.author === "sam" && c.body.includes("CI failed on"))
      ? t
      : undefined;
  });

  assertEq(
    ci.comments.some((c: Json) => c.body.includes("failing: build")),
    true,
    "the round saw the failing check by name",
  );

  step(
    `ci: the build of #${pr2.pr.number} failed -> a round for its author, who looked at the failing check`,
  );

  // ---- 10c. the blocked ticket is assigned to the agent again and the agent is still blocked: the office moves the
  // ticket to active for the agent when the work starts, the agent blocks it again, it goes to the PM again, who gives
  // it back to the requester, and no earlier blocked item is left behind.
  const before10c = (await state()).tickets.find((x: Json) => x.key === stuck);
  const movesBefore = before10c.moves.length;
  const askedBefore = before10c.comments.filter((c: Json) => c.author === "pia").length;
  const piaBefore10c = piaWakes().length;
  await stub("POST", `/_test/tickets/${stuck}/assign`, { to: "sam" });
  const retried = await until(
    `${stuck}: the retry handed back as blocked, and on to the requester`,
    (s) => {
      const t = s.tickets.find((x: Json) => x.key === stuck);
      const asked = t.comments.filter((c: Json) => c.author === "pia").length;
      return t.assignee === "ada.admin" && asked > askedBefore ? t : undefined;
    },
  );

  assertEq(retried.status, "Blocked", "the ticket is still blocked after the retry");
  assertEq(
    JSON.stringify(retried.moves.slice(movesBefore).map((m: Json) => `${m.from}>${m.to}`)),
    JSON.stringify(["Blocked>In Progress", "In Progress>Blocked"]),
    "the retry started with the ticket active, and the agent blocked it again",
  );

  await officePolledTwice(`${stuck} went to the requester again`);
  assertEq(
    JSON.stringify(piaWakes().slice(piaBefore10c)),
    JSON.stringify(["unblock"]),
    "pia was woken once for the retry's hand-back, to unblock it",
  );

  step(
    `blocked retry: ${stuck} assigned to sam again, still blocked -> active when the work started, blocked again by sam, the PM gave it back to the requester`,
  );

  // ---- 11b. a human mentions the agent on the ticket it left blocked with the human: the ticket is the agent's again
  const mentionText = "@sam the staging key is rotated, please carry on.";
  const movesBeforeMention = retried.moves.length;
  await stub("POST", `/_test/tickets/${stuck}/comment`, { body: mentionText });
  const mentioned = await until(
    `${stuck}: the mention answered and the ticket handed back again`,
    (s) => {
      const t = s.tickets.find((x: Json) => x.key === stuck);
      const answer = t.comments.find(
        (c: Json) => c.author === "sam" && c.body === `Noted: ${mentionText}`,
      );

      return answer && t.status === "In Review" && t.assignee === "ada.admin" ? t : undefined;
    },
  );

  assertEq(
    mentioned.moves
      .slice(movesBeforeMention)
      .filter((m: Json) => m.from === "Blocked" && m.to === "In Progress").length,
    1,
    "the mention moved the blocked ticket to active once",
  );

  step(
    `mention: @sam on the blocked ${stuck} (held by the human) assigned it to sam and made it active; sam answered and handed it back`,
  );

  // Before the last step: merging another pull request makes the second one conflict with main again.
  const final = await state();
  const t2 = final.tickets.find((x: Json) => x.key === second);
  assertEq(t2.status, "In Review", "the second ticket waits in review");

  // ---- 12. merge on approval (policies.merge.on_approval): the approval wakes the author to decide (kind `merge`),
  // with the merge context; nothing else is approved, so it merges: `ost pr merge` joins the merge queue, the queue
  // merges it and the ticket is done
  const before12 = (await state()).github.pulls.find((p: Json) => p.number === made.pr.number);
  assertEq(before12.autoMerge, false, "marking the pull request ready set nothing to merge");
  assertEq(before12.queued, false, "nothing joined the merge queue before the approval");
  const head12 = before12.head.sha;

  await approve(made.pr.number);
  const queued = await until(`#${made.pr.number} put in the merge queue by its author`, (s) =>
    s.github.pulls.find((p: Json) => p.number === made.pr.number && p.queued),
  );

  assertEq(queued.head.sha, head12, "the queue took the head the approver saw");
  const done12 = await until(
    `#${made.pr.number} merged by the queue and ${made.t.key} done`,
    (s) => {
      const pr = s.github.pulls.find((p: Json) => p.number === made.pr.number);
      const t = s.tickets.find((x: Json) => x.key === made.t.key);
      return pr.state === "merged" && t.status === "Done" ? pr : undefined;
    },
  );

  assertEq(done12.state, "merged", "the pull request merged");
  step(
    `merge on approval: #${made.pr.number} approved -> its author woken to merge, it joined the queue, merged, ${made.t.key} done`,
  );

  // ---- 13. two approved pull requests that change the same file: one merge at a time. The older one merges; the
  // newer one's merge wake sees it in the merge context (approved, changing the same file) and waits; once the older
  // one merged, the newer one conflicts, is rebased, approved again and merges.
  const pair = [
    await stub("POST", "/_test/tickets", { title: "Add a morning greeting", assignee: "sam" }),
    await stub("POST", "/_test/tickets", { title: "Add an evening greeting", assignee: "sam" }),
  ].map((t: Json) => t.key as string);

  const opened = await until("pull requests for both greetings, in review", (s) => {
    const prs = pair.map((key) =>
      s.github.pulls.find((p: Json) => p.body.includes(`Closes ${key}`)),
    );

    const reviewed = pair.every(
      (key) => s.tickets.find((x: Json) => x.key === key).status === "In Review",
    );

    return prs.every(Boolean) && reviewed ? prs : undefined;
  });

  const [older, newer] = opened.toSorted((a: Json, b: Json) => a.number - b.number);
  await approve(older.number);
  await approve(newer.number);
  const first13 = await until(`#${older.number} merged first`, (s) => {
    const o = s.github.pulls.find((p: Json) => p.number === older.number);
    const n = s.github.pulls.find((p: Json) => p.number === newer.number);
    return o.state === "merged" ? n : undefined;
  });

  assertEq(
    first13.queued,
    false,
    `#${newer.number} waited: it did not join the queue beside #${older.number}`,
  );

  const rebased13 = await until(
    `#${newer.number} rebased on main after #${older.number} merged`,
    (s) => {
      const pr = s.github.pulls.find((p: Json) => p.number === newer.number);
      return pr.forcePushes > 0 && pr.containsMain && pr.mergeable === true ? pr : undefined;
    },
  );

  // A push needs a new approval: the rebased head is approved again, which wakes its author to merge.
  await approve(newer.number);
  const second13 = await until(`#${newer.number} merged after its rebase`, (s) => {
    const pr = s.github.pulls.find((p: Json) => p.number === newer.number);
    return pr.state === "merged" ? pr : undefined;
  });

  assertEq(second13.head.sha, rebased13.head.sha, "the rebased head is what merged");
  step(
    `merge order: #${older.number} and #${newer.number} change the same file -> #${older.number} merged, #${newer.number} waited, rebased, merged`,
  );

  // ---- 13b. a human asks the PM in chat to file a ticket for sam: the ticket is sam's from the start, sam is woken on
  // it, and the PM's chat session neither works on it nor hands it to the requester
  const piaBefore13b = piaWakes().length;
  const forSam = "Add a status page";
  const asked13b = await stub("POST", "/_test/chat/say", {
    to: "pia",
    text: `New work for sam: ${forSam}`,
  });

  const reply13b = await until(
    "pia's reply in her thread, naming the ticket she filed for sam",
    (s) =>
      s.chat.posts.find(
        (p: Json) => p.agent === "pia" && p.thread === asked13b.id && /for sam/.test(p.text),
      ),
  );

  const filed13b = (await state()).tickets.find((t: Json) => t.title === forSam);
  assertEq(!!filed13b, true, "pia created the ticket");
  assertEq(reply13b.text.includes(filed13b.key), true, "pia's reply names the ticket");
  const pr13b = await until(`sam's pull request for ${filed13b.key}, handed back`, (s) => {
    const pr = s.github.pulls.find((p: Json) => p.body.includes(`Closes ${filed13b.key}`));
    const t = s.tickets.find((x: Json) => x.key === filed13b.key);
    return pr && t.status === "In Review" ? { pr, t } : undefined;
  });

  assertEq(pr13b.pr.author, "acme-sam[bot]", "sam opened the pull request");
  assertEq(
    JSON.stringify(pr13b.t.moves.map((m: Json) => `${m.from}>${m.to} by ${m.by}`)),
    JSON.stringify(["Ready>In Progress by sam", "In Progress>In Review by sam"]),
    "only sam's own work moved the ticket: the PM's chat session neither started nor handed it back",
  );

  assertEq(
    JSON.stringify(piaWakes().slice(piaBefore13b)),
    JSON.stringify(["chat"]),
    "pia ran only the chat session: no work item of hers was filed for the ticket",
  );

  step(
    `file for a teammate: pia filed ${filed13b.key} for sam from chat -> sam was woken and opened #${pr13b.pr.number}; pia never worked on it`,
  );

  // ---- 14. every change in the tracker and the knowledge base was made by an agent (sam, or pia, the PM) or a human, as
  // themselves: the office's account only reads (decision 0019)
  const authors = await state();
  const by = [
    ...authors.tickets.flatMap((t: Json) => [
      ...t.moves.map((m: Json) => [`${t.key} ${m.from}>${m.to}`, m.by]),
      ...t.comments.map((c: Json) => [`a comment on ${t.key}`, c.author]),
    ]),
    ...authors.docs.flatMap((d: Json) =>
      d.comments.map((c: Json) => [`a comment on ${d.title}`, c.author]),
    ),
  ] as [string, string | null][];

  const others = by.filter(([, who]) => !["sam", "pia", "ada.admin"].includes(who ?? ""));
  assertEq(
    others.map(([what, who]) => `${what} by ${who}`).join("; "),
    "",
    "every tracker and document change is made by an agent or a human",
  );

  step(
    `authors: all ${by.length} moves and comments were made by an agent or a human, none by the office`,
  );

  log(`all steps passed in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

/** The merge approver approves the pull request's current head. */
async function approve(number: number) {
  await stub("POST", `/_test/pulls/${number}/review`, {
    state: "approved",
    actor: "merge-approver",
  });
}

function assertEq(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(list: string[], item: string, what: string) {
  if (!list.includes(item)) {
    throw new Error(`${what}: ${JSON.stringify(item)} not in ${JSON.stringify(list)}`);
  }
}

const bound = setTimeout(() => {
  fail(new Error(`The run took longer than ${(deadline - started) / 1000}s.`));
}, deadline - started);

try {
  await main();
  clearTimeout(bound);
  log(
    "timings: " +
      timings.map(([n, ms]) => `${n.split(":")[0]} ${(ms / 1000).toFixed(0)}s`).join(", "),
  );

  teardown(0);
} catch (e) {
  clearTimeout(bound);
  fail(e);
}
