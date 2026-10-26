// The acme loop end to end, on Docker Compose: a ticket is assigned, the agent clones, commits and opens a pull
// request, a human asks for changes while another asks a question in chat (answered by a chat session before the round ends), the agent fixes and resolves the thread, a review with only a summary gets a
// pull request comment, a batch review with two inline comments gets a reply in each thread, a short "yes" to the agent's own earlier comment is answered from the conversation, the human merges, a
// second pull request now conflicts and the agent rebases it and pushes with a lease, and a comment on the merged pull
// request gets a reply and a follow-up pull request (for a sub-ticket of its own), and a ticket that needs two pull
// requests is split into a sub-ticket first, so that each ticket has one (merging the first closes only its own
// ticket), and a direct message with a picture is answered and its ticket gets the picture. The office, Postgres and the agent are the real images; GitHub,
// the tracker and the model are stand-ins (e2e/stubs, e2e/runtime-scripted).
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

/** Polls until `check` returns a value that is not undefined or false; the failure says what was waited for. */
async function until<T>(
  what: string,
  check: (s: Json) => T | undefined | false,
  ms = 150_000,
): Promise<T> {
  const limit = Math.min(Date.now() + ms, deadline);
  let s: Json = {};
  while (Date.now() < limit) {
    s = await state();
    const hit = check(s);
    if (hit !== undefined && hit !== false) {
      return hit;
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for: ${what}\nstub state: ${JSON.stringify(s, null, 2)}`);
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
  for (const service of ["stubs", "office", "sam"]) {
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

function prepareSecrets(privateKey: string, keys: { office: string; sam: string }) {
  const s = join(work, "secrets");
  const token = randomBytes(24).toString("hex");
  write(join(s, "office/GH_OFFICE_APP_ID"), "100");
  write(join(s, "office/GH_OFFICE_APP_PRIVATE_KEY"), privateKey);
  write(join(s, "office/ITSAPLAN_API_KEY"), keys.office);
  write(join(s, "office/SLACK_OFFICE_BOT_TOKEN"), "dummy-not-used");
  write(join(s, "sam/OUTSTAFF_AGENT_TOKEN"), token);
  write(join(s, "office/OUTSTAFF_AGENT_TOKEN_MIRA"), randomBytes(24).toString("hex"));
  write(join(s, "sam/GH_APP_ID"), "201");
  write(join(s, "sam/GH_APP_PRIVATE_KEY"), privateKey);
  write(join(s, "sam/ITSAPLAN_API_KEY"), keys.sam);
}

const TEAM = `version: 1
team: { name: acme, product: Acme Shop }
humans:
  - name: Ada Admin
    identities: { vcs: ada-admin, tracker: ada.admin, chat: U0ADA00001 }
  - name: Grace Lead
    identities: { vcs: grace-lead }
catalog: { version: 0.0.0 }
repos:
  - { name: shop, url: github.acme.example/acme/shop, kind: primary }
people: []
integrations:
  chat: { adapter: slack }
  vcs:
    adapter: github
    apiUrl: http://github.acme.example:8081/api/v3
    webUrl: https://github.acme.example
  runtime: { adapter: scripted }
  tracker:
    adapter: itsaplan
    url: http://tracker.acme.example:8081/tracker
    api_url: http://tracker.acme.example:8081/tracker
    project: SHOP
workflow:
  preset: kanban
  statuses:
    backlog: Backlog
    ready: Ready
    active: In Progress
    review: In Review
    blocked: Blocked
    done: Done
    canceled: Canceled
office: { events: poll, poll_interval_seconds: 10 }
policies:
  commands:
    # The code toolset allows pnpm's verbs, not \`pnpm --version\`; the scripted agent checks the tool with it.
    allow:
      - program: pnpm
        args: [{ kind: flag, names: [--version], present: true }]
        reason: Prints the version of the tool the toolset installed.
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
    { role: "developer", handle: "sam", name: "Sam Duarte", pronouns: "they/them" },
    { role: "architect", handle: "mira", name: "Mira Okafor", pronouns: "she/her" },
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
        "--repos",
        "shop=write",
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
    const patched = text.replace(
      new RegExp(`(\\n {4}role: ${p.role}\\n)`),
      `$1    identities:\n      vcs: acme-${p.handle}[bot]\n      tracker: ${p.handle}\n`,
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

async function main() {
  hire();
  step("hire: ost hire developer sam and architect mira, team file validates");

  const privateKey = prepareKeys();
  const keys = { office: randomBytes(12).toString("hex"), sam: randomBytes(12).toString("hex") };
  prepareSecrets(privateKey, keys);
  composeEnv = {
    ...process.env,
    E2E_DIR: work,
    E2E_PROJECT: project,
    E2E_STUB_PORT: port,
    POSTGRES_PASSWORD: randomBytes(12).toString("hex"),
    STUB_APPS: "100=acme-office,201=acme-sam",
    STUB_TRACKER_KEYS: `${keys.office}=office,${keys.sam}=sam`,
  };

  if (process.env["E2E_PREBUILT"] !== "1") {
    // The tags are the defaults of compose.e2e.yaml.
    for (const [target, tag] of [
      ["office", "outstaff/office:local"],
      ["agent-e2e", "outstaff/agent-e2e:local"],
      ["e2e-stubs", "outstaff/e2e-stubs:local"],
    ] as const) {
      // Docker Hub answers the frontend lookup with a gateway error now and then; a build is worth a retry.
      let build = buildImage(target, tag);
      for (let attempt = 1; build.status !== 0 && attempt < 3; attempt++) {
        await sleep(5_000);
        build = buildImage(target, tag);
      }

      if (build.status !== 0) {
        throw new Error(`The ${target} image did not build:\n${build.stdout}${build.stderr}`);
      }
    }

    step("images: built office, agent-e2e and stubs");
  }

  const up = dc("up", "-d", "--wait", "--wait-timeout", "240", "stubs", "office");
  if (up.status !== 0) {
    throw new Error(`The stack did not come up:\n${up.stdout}${up.stderr}`);
  }

  step("stack: stubs, Postgres and the office are healthy");
  const sam = dc("up", "-d", "--no-deps", "sam");
  if (sam.status !== 0) {
    throw new Error(`The agent did not start:\n${sam.stdout}${sam.stderr}`);
  }

  for (let i = 0; i < 60 && !/"agent connected","person":"sam"/.test(logs("office")); i++) {
    await sleep(1_000);
  }

  if (!/"agent connected","person":"sam"/.test(logs("office"))) {
    throw new Error("The agent never connected to the office.");
  }

  step("agent: sam connected to the office");

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
  assertIncludes(moved, "Ready>In Progress", "sam moved the ticket to active");
  assertIncludes(moved, "In Progress>In Review", "the ticket went to review");
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
    body: "Please greet properly.",
    comments: [{ path: "greeting.txt", line: 1, body: "Say hello to someone." }],
  });

  await until("the review round running and held at the gate", (s) => s.chat.gates.review?.arrived);

  // The agent publishes its profile for the trusted human while the round runs: working on the ticket, linked.
  const published = await until("a chat profile with the active item", (s) =>
    s.chat.profiles.findLast(
      (p: Json) =>
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

  await stub("POST", "/_test/gates/review/open");

  const fixed = await until(
    "a fix pushed, the thread answered and resolved, the ticket back in review",
    (s) => {
      const pr = s.github.pulls.find((p: Json) => p.number === pr1.pr.number);
      const t = s.tickets.find((x: Json) => x.key === first);
      const thread = pr.threads[0];
      return pr.head.sha !== before &&
        thread?.resolved &&
        thread.comments.length > 1 &&
        t.status === "In Review"
        ? { pr, t, thread, github: s.github }
        : undefined;
    },
  );

  const strays = Object.keys(fixed.github.branches).filter((b) => /^review[-_]feedback\//.test(b));

  assertEq(
    strays.length,
    0,
    "the review round pushed to the pull request's branch, no branch of its own",
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
  assertIncludes(rounds, "In Review>In Progress", "the review sent the ticket back to active");
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
    s.chat.profiles.findLast((p: Json) => p.userId === "U0ADA00001")?.profile.status === "idle"
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
  assertEq(
    JSON.stringify(split.child.links),
    JSON.stringify([{ from: split.child.key, to: parent, kind: "relates" }]),
    "the sub-ticket is linked to its parent",
  );

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

  const final = await state();
  const t2 = final.tickets.find((x: Json) => x.key === second);
  assertEq(t2.status, "In Review", "the second ticket waits in review");
  log(`all steps passed in ${((Date.now() - started) / 1000).toFixed(0)}s`);
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
