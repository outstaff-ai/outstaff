import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { createOfficeConnection, loadToolsets, runMise, verifyTools } from "@outstaff/agent";
import { join } from "node:path";
import {
  effectiveTools,
  envSecretSource,
  formatIssue,
  networkGrants,
  originOf,
  renderPerson,
  validateTeam,
  type DoctorCheck,
  type SecretSource,
  type TeamConfig,
} from "@outstaff/core";
import {
  catalogIssue,
  loadCatalogs,
  roleProfile,
  roleRegistry,
  stockCatalogDir,
  type TeamCatalogs,
} from "../catalogs.js";
import { defineCommand, type Context } from "../define.js";
import { loadTeam } from "../load.js";
import { adapterSecretKeys } from "../secret-keys.js";
import { projectRoot, secretsLocation } from "../project.js";
import { configuredAdapters, shippedRegistry } from "./setup.js";
import { sections, type Scope } from "./setup-template.js";

type Status = DoctorCheck["status"];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A key whose file may stand in for it; the spec for the alternative itself is then not required. */
const FILE_ALTERNATIVE = /_PRIVATE_KEY$/;

const fail = (name: string, detail: string, fix: string, key?: string): DoctorCheck => ({
  ...(key ? { key } : {}),
  name,
  status: "fail",
  detail,
  fix,
});

function modeOf(path: string): number | undefined {
  try {
    const st = statSync(path);
    return st.isFile() ? st.mode & 0o777 : undefined;
  } catch {
    return undefined;
  }
}

/** Presence of every required key and the mode of every secret file. */
function secretChecks(
  list: ReturnType<typeof sections>,
  secrets: SecretSource,
  dir: string,
  handle: string,
): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const specs = list.flatMap((s) => s.specs);
  for (const spec of specs) {
    if (spec.key.endsWith("_PRIVATE_KEY_FILE")) {
      continue;
    }

    const alt = FILE_ALTERNATIVE.test(spec.key) ? `${spec.key}_FILE` : undefined;
    const present = secrets.get(spec.key) !== undefined || (alt && secrets.get(alt) !== undefined);
    if (present) {
      if (!spec.optional) {
        out.push({
          key: spec.key,
          name: `${spec.key} present`,
          status: "ok",
          detail: "Provided.",
        });
      }
    } else if (!spec.optional) {
      out.push(
        fail(
          `${spec.key} present`,
          `${spec.key} is not set as a file in ${dir} or in the environment.`,
          spec.derivable
            ? `Run \`ost setup ${handle} --derive\`, or create ${join(dir, spec.key)}.`
            : `Create ${join(dir, spec.key)} (${spec.where}).`,
          spec.key,
        ),
      );
    }
  }

  for (const spec of specs) {
    const file = join(dir, spec.key);
    const mode = modeOf(file);
    if (mode === undefined || process.platform === "win32") {
      continue;
    }

    if ((mode & 0o077) !== 0) {
      out.push(
        fail(
          `${spec.key} file mode`,
          `${file} has mode ${mode.toString(8).padStart(4, "0")}; other users can read it.`,
          `chmod 600 ${file}`,
          spec.key,
        ),
      );
    } else if (mode !== 0o600) {
      out.push({
        key: spec.key,
        name: `${spec.key} file mode`,
        status: "warn",
        detail: `${file} has mode ${mode.toString(8).padStart(4, "0")}, not 0600.`,
        fix: `chmod 600 ${file}`,
      });
    }
  }

  if (!out.some((c) => c.name.endsWith("file mode"))) {
    const files = specs.filter((s) => modeOf(join(dir, s.key)) !== undefined).length;
    if (files > 0) {
      out.push({
        name: "Secret file modes",
        status: "ok",
        detail: `${plural(files, "secret file")} in ${dir}, all 0600.`,
      });
    }
  }

  return out;
}

const OFFICE_TIMEOUT_MS = 5_000;
const CONTAINER_SECRETS_DIR = "/run/secrets/outstaff";

/** Health is served on its own port, so it is probed at `OUTSTAFF_OFFICE_HEALTH_URL` or else at the office URL's origin. */
function healthUrl(env: Record<string, string | undefined>, officeUrl: string): string {
  const given = env["OUTSTAFF_OFFICE_HEALTH_URL"];
  if (given) {
    return `${given.replace(/\/+$/, "")}/healthz`;
  }

  const u = new URL(officeUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  return `${u.origin}/healthz`;
}

/** Is the office up, and does it accept this person's token? Only the handshake; the token is never printed. */
async function officeChecks(
  ctx: Context,
  secrets: SecretSource,
  handle: string,
): Promise<DoctorCheck[]> {
  const url = ctx.env["OUTSTAFF_OFFICE_URL"] || secrets.get("OUTSTAFF_OFFICE_URL");
  if (!url) {
    return [
      {
        name: "Office reachable",
        status: "warn",
        detail: "OUTSTAFF_OFFICE_URL is not set, so the office was not contacted.",
        fix: "Set OUTSTAFF_OFFICE_URL to the office's WebSocket URL, for example ws://office:8080/agent.",
      },
    ];
  }

  const unreachable = (why: string): DoctorCheck[] => [
    {
      name: "Office reachable",
      status: "fail",
      detail: `office unreachable at ${url}${why ? ` (${why})` : ""}`,
      fix: "Check the office is running, OUTSTAFF_OFFICE_URL is right and the network allows the connection.",
    },
  ];

  let health: string;
  try {
    health = healthUrl(ctx.env, url);
  } catch {
    return [
      {
        name: "Office reachable",
        status: "fail",
        detail: `OUTSTAFF_OFFICE_URL "${url}" is not a URL.`,
        fix: "Use a ws:// or wss:// URL such as ws://office:8080/agent.",
      },
    ];
  }

  const out: DoctorCheck[] = [];
  try {
    const res = await (ctx.fetch ?? fetch)(health, {
      signal: AbortSignal.timeout(OFFICE_TIMEOUT_MS),
    });

    if (res.ok) {
      out.push({ name: "Office health", status: "ok", detail: `${health} answers ${res.status}.` });
    } else if (res.status === 404) {
      out.push({
        name: "Office health",
        status: "warn",
        detail: `${health} answered 404; the office serves health on its own port.`,
        fix: "Set OUTSTAFF_OFFICE_HEALTH_URL to the office's health address, for example http://office:8081.",
      });
    } else {
      out.push({
        name: "Office health",
        status: "fail",
        detail: `${health} answered ${res.status}: the office is up but reports a failing part.`,
        fix: "Look at the office's logs.",
      });
    }
  } catch (e) {
    return unreachable((e as Error).name === "TimeoutError" ? "timed out" : "");
  }

  const token = secrets.get("OUTSTAFF_AGENT_TOKEN");
  if (!token) {
    return out;
  }

  const conn = createOfficeConnection({
    url,
    person: handle,
    token,
    agentVersion: "doctor",
    backoff: { baseMs: OFFICE_TIMEOUT_MS * 2 },
  });

  conn.start();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      conn.whenConnected(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timed out")),
          ctx.officeTimeoutMs ?? OFFICE_TIMEOUT_MS,
        );
      }),
    ]);

    out.push({
      key: "OUTSTAFF_AGENT_TOKEN",
      name: "Office accepts the agent token",
      status: "ok",
      detail: `The office accepted the connection of ${handle}.`,
    });
  } catch {
    const rejection = conn.rejection();
    out.push(
      rejection
        ? {
            key: "OUTSTAFF_AGENT_TOKEN",
            name: "Office accepts the agent token",
            status: "fail",
            detail:
              rejection.code === "auth_failed"
                ? `office rejected the agent token for ${handle}`
                : `office refused the connection of ${handle} (${rejection.code})`,
            fix:
              rejection.code === "auth_failed"
                ? `Make OUTSTAFF_AGENT_TOKEN equal the office's OUTSTAFF_AGENT_TOKEN_${handle.toUpperCase().replaceAll("-", "_")}.`
                : "Run the same Outstaff version as the office.",
          }
        : unreachable("the handshake did not complete")[0]!,
    );
  } finally {
    clearTimeout(timer);
    await conn.stop();
  }

  return out;
}

/**
 * Does every tool the person's toolsets and `tools:` declare resolve through mise from the home directory, the
 * way a shim does for the agent? Only the agent's own container has them installed, so from anywhere else a
 * failure is a warning.
 */
async function toolChecks(
  ctx: Context,
  team: TeamConfig,
  person: TeamConfig["people"][number],
  catalogs: TeamCatalogs | undefined,
  inContainer: boolean,
): Promise<DoctorCheck[]> {
  if (!catalogs) {
    return [];
  }

  let extended: string[];
  try {
    extended = renderPerson({
      team,
      handle: person.handle,
      catalog: catalogs.stock,
      ...(catalogs.ejected ? { ejected: catalogs.ejected } : {}),
    }).extends;
  } catch {
    return [];
  }

  const roles = { ...catalogs.stock.roles, ...catalogs.ejected?.roles };
  const toolsets = loadToolsets(stockCatalogDir(ctx), roles, person.role, extended);
  const tools = effectiveTools({ toolsets, team: team.tools, person: person.tools });
  if (tools.length === 0) {
    return [];
  }

  const status: Status = inContainer ? "fail" : "warn";
  const home = ctx.home ?? homedir();
  const mise = ctx.mise ?? runMise;
  const probe = await mise(["--version"], { cwd: home, env: ctx.env });
  if (probe.code !== 0) {
    return [
      {
        name: "Tools resolve",
        status,
        detail: "mise is not installed here, so the declared tools were not checked.",
        fix: `Run \`ost doctor ${person.handle}\` inside the agent container.`,
      },
    ];
  }

  const failed = await verifyTools({ tools, home, env: ctx.env, mise });
  if (failed.length === 0) {
    return [
      {
        name: "Tools resolve",
        status: "ok",
        detail: `${plural(tools.length, "tool")} resolve${tools.length === 1 ? "s" : ""}: ${tools.map((t) => `${t.name}@${t.version}`).join(", ")}.`,
      },
    ];
  }

  return failed.map((t) => ({
    name: `Tool ${t.name} resolves`,
    status,
    detail: t.error ?? `${t.name}@${t.version} does not resolve.`,
    fix: "Restart the agent so it installs its tools and writes the global mise config; check the egress to the tool sources.",
  }));
}

const PROBE_TIMEOUT_MS = 5_000;

const tcpReachable = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host, port, timeout: PROBE_TIMEOUT_MS });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });

    for (const event of ["error", "timeout"] as const) {
      socket.once(event, () => {
        socket.destroy();
        resolve(false);
      });
    }
  });

const adbRuns = (env: NodeJS.ProcessEnv): Promise<boolean> =>
  new Promise((resolve) => {
    execFile("adb", ["version"], { env, timeout: PROBE_TIMEOUT_MS }, (error) => resolve(!error));
  });

/**
 * Does each HTTP service of the person answer, and each adb device accept a connection? The service is probed
 * without its token, so a 401 still counts: it answered. The network path itself (for example a Kubernetes
 * NetworkPolicy) is only visible from inside the agent container, so elsewhere a failure is a warning.
 */
async function networkChecks(
  ctx: Context,
  team: TeamConfig,
  person: TeamConfig["people"][number],
  inContainer: boolean,
): Promise<DoctorCheck[]> {
  const grants = networkGrants(team, person);
  const status: Status = inContainer ? "fail" : "warn";
  const out: DoctorCheck[] = [];
  for (const g of grants.http) {
    const origin = originOf(g.url)!;
    const unreachable = (why: string): DoctorCheck => ({
      name: `Service ${g.name} answers`,
      status,
      detail: `${origin} did not answer (${why}).`,
      fix: `Check the service is up and that the deployment allows the agent to reach ${new URL(origin).host} (for example a Kubernetes NetworkPolicy).`,
    });

    try {
      const res = await (ctx.fetch ?? fetch)(origin, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });

      out.push({
        name: `Service ${g.name} answers`,
        status: "ok",
        detail: `${origin} answered ${res.status}.`,
      });
    } catch (e) {
      out.push(
        unreachable((e as Error).name === "TimeoutError" ? "timed out" : "connection failed"),
      );
    }
  }

  if (grants.adb.length === 0) {
    return out;
  }

  const adbOk = await (ctx.adbProbe ?? (() => adbRuns(ctx.env)))();
  out.push(
    adbOk
      ? { name: "adb runs", status: "ok", detail: "adb is on the PATH." }
      : {
          name: "adb runs",
          status,
          detail: "adb is not installed here or does not run.",
          fix: "Declare adb under tools in team.yaml (see the network grants guide) and restart the agent, or put it on the PATH of the image.",
        },
  );

  let remembered: Record<string, { host: string; port: number }> = {};
  try {
    remembered = JSON.parse(
      readFileSync(join(ctx.home ?? homedir(), ".outstaff", "adb-ports.json"), "utf8"),
    ) as typeof remembered;
  } catch {
    // nothing remembered yet
  }

  for (const g of grants.adb) {
    const saved = remembered[g.name];
    const port = g.port ?? (saved?.host === g.host ? saved.port : undefined);
    if (port === undefined) {
      out.push({
        name: `Device ${g.name} reachable`,
        status: "ok",
        detail: `${g.host} uses wireless debugging; no connect port is remembered yet, so it was not probed. A human gives the first port to \`ost adb connect\`.`,
      });

      continue;
    }

    const up = await (ctx.tcpProbe ?? tcpReachable)(g.host, port);
    out.push(
      up
        ? {
            name: `Device ${g.name} reachable`,
            status: "ok",
            detail: `${g.host}:${port} accepts connections.`,
          }
        : {
            name: `Device ${g.name} reachable`,
            status: g.pairing ? "warn" : status,
            detail: `${g.host}:${port} did not accept a connection.`,
            fix: g.pairing
              ? "The wireless debugging port changes after a reboot or a toggle; a human gives the current one to `ost adb connect`. Also check the deployment allows the agent to reach the device (for example a Kubernetes NetworkPolicy)."
              : "Check the device is on with adb over TCP enabled, and that the deployment allows the agent to reach it (for example a Kubernetes NetworkPolicy).",
          },
    );
  }

  return out;
}

interface ScopeReport {
  scope: string;
  checks: (DoctorCheck & { adapter?: string })[];
}

async function checkScope(
  ctx: Context,
  team: TeamConfig,
  handle: string,
  dir: string,
  registry: Awaited<ReturnType<typeof shippedRegistry>>,
  catalogs: TeamCatalogs | undefined,
): Promise<ScopeReport> {
  const scope: Scope = handle === "office" ? "office" : "person";
  const person = scope === "person" ? team.people.find((p) => p.handle === handle) : undefined;
  const { found, unknown } = configuredAdapters(team, registry, scope);
  const secrets = envSecretSource(ctx.env, dir);
  const list = sections(
    team,
    found.map((f) => f.def),
    scope,
    person,
  );

  const checks: ScopeReport["checks"] = secretChecks(list, secrets, dir, handle);
  for (const u of unknown) {
    checks.push({
      name: `${u} not checked`,
      status: "warn",
      detail: `${u} is not shipped in this build, so its secrets and setup are not checked.`,
    });
  }

  if (scope === "person") {
    checks.push(...(await officeChecks(ctx, secrets, handle)));
    if (person) {
      checks.push(
        ...(await toolChecks(ctx, team, person, catalogs, dir === CONTAINER_SECRETS_DIR)),
        ...(await networkChecks(ctx, team, person, dir === CONTAINER_SECRETS_DIR)),
      );
    }
  } else if (dir !== CONTAINER_SECRETS_DIR) {
    checks.push({
      name: "Office checks itself",
      status: "warn",
      detail:
        "The office scope checks the secrets and providers visible from here; the running office is not contacted.",
      fix: "Run `ost doctor office` inside the office container to check what the office itself sees.",
    });
  }

  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const { def, options } of found) {
    if (!def.doctor) {
      continue;
    }

    let result: DoctorCheck[];
    try {
      result = await def.doctor(secrets, {
        team,
        scope,
        options,
        ...(person ? { person, ...roleProfile(catalogs, person.role) } : {}),
        fetch: ctx.fetch ?? fetch,
        now: ctx.now ?? (() => new Date()),
        warn: (m) => warnings.push(m),
      });
    } catch (e) {
      result = [
        fail(
          `${def.name} checks`,
          `The checks could not run: ${(e as Error).message}`,
          "Fix the error above and run again.",
        ),
      ];
    }

    for (const c of result) {
      // Tracker and knowledge adapters share one provider; report its answer once.
      const id = JSON.stringify([def.name, c.name, c.detail]);
      if (!seen.has(id)) {
        seen.add(id);
        checks.push({ ...c, adapter: def.name });
      }
    }
  }

  for (const w of warnings) {
    checks.push({ name: "Note", status: "warn", detail: w });
  }

  // Backstop: a check must not carry a secret even by accident.
  const values = list
    .flatMap((s) => s.specs.filter((k) => !k.derivable && !k.key.endsWith("_ID")))
    .map((k) => secrets.get(k.key))
    .filter((v): v is string => v !== undefined && v.length >= 6);

  const scrub = (text: string) => values.reduce((t, v) => t.replaceAll(v, "***"), text);
  return {
    scope: handle,
    checks: checks.map((c) => ({
      ...c,
      detail: scrub(c.detail),
      ...(c.fix ? { fix: scrub(c.fix) } : {}),
    })),
  };
}

export const doctor = defineCommand<{ secretsDir?: string }>({
  name: "doctor",
  summary: "Verify the secrets and the setup of the office and of each person.",
  description:
    "Validates the team file, then for each scope checks that every required secret is present (as a file in the secrets directory or in the environment, the same way the containers read them), that secret files are mode 0600, and each adapter's live checks: the GitHub App key signs and the office App covers the granted repositories and the person's own App exactly the ones they can write, with the right permissions, the office App is read-only, the Slack bot token and ids match, the Its a Plan key works and belongs to the configured member, a Claude credential is supplied, every tool declared for the person resolves through mise, every HTTP service granted to the person answers and every adb device accepts a connection (failures inside the agent container, warnings elsewhere). Every finding names the value to fix and never prints a secret. Without a handle it checks the office and every person from one secrets directory.",
  args: "[handle|office]",
  options: [
    {
      flags: "--secrets-dir <dir>",
      description:
        "Directory of secret files, used for every scope checked. Defaults to OUTSTAFF_SECRETS_DIR, then .outstaff/secrets/<handle|office> next to the team file.",
    },
  ],
  examples: [
    "ost doctor",
    "ost doctor sam --secrets-dir ./secrets-sam",
    "ost doctor office --json",
  ],
  exitCodes: [
    "0: no check failed (warnings are allowed)",
    "1: a check failed, the team file has errors, or the person is unknown",
  ],
  async run(ctx, options, args) {
    const target = args[0];
    const loaded = await loadTeam(ctx, options);
    if (!loaded.ok) {
      for (const i of loaded.issues) {
        ctx.err(`error    ${formatIssue(i)}\n`);
      }

      return 1;
    }

    const { config } = loaded;
    const registry =
      ctx.registry && ctx.registry.list().length > 0 ? ctx.registry : await shippedRegistry();

    const found = loadCatalogs(ctx, config, loaded.source.dir);
    const issues = found.ok
      ? validateTeam(config, {
          roles: roleRegistry(found.catalogs),
          adapters: new Map(),
          secretKeys: adapterSecretKeys(registry),
        }).errors.map(loaded.locate)
      : found.issues.map(catalogIssue);

    if (issues.length > 0) {
      for (const i of issues) {
        ctx.err(`error    ${formatIssue(i)}\n`);
      }

      ctx.err("The team file has errors; fix them before running doctor (see `ost validate`).\n");
      return 1;
    }

    if (target && target !== "office" && !config.people.some((p) => p.handle === target)) {
      ctx.err(
        `Unknown person "${target}". People in this team: ${config.people.map((p) => p.handle).join(", ") || "none"}. Use "office" for the office.\n`,
      );

      return 1;
    }

    const handles = target ? [target] : ["office", ...config.people.map((p) => p.handle)];
    const root = projectRoot(ctx, loaded.source);

    const reports: ScopeReport[] = [];
    for (const h of handles) {
      reports.push(
        await checkScope(
          ctx,
          config,
          h,
          secretsLocation(ctx, options, root, h).dir,
          registry,
          found.ok ? found.catalogs : undefined,
        ),
      );
    }

    const count = (s: Status) =>
      reports.reduce((n, r) => n + r.checks.filter((c) => c.status === s).length, 0);

    const summary = { ok: count("ok"), warn: count("warn"), fail: count("fail") };

    if (options.json) {
      ctx.out(`${JSON.stringify({ ok: summary.fail === 0, summary, scopes: reports }, null, 2)}\n`);
      return summary.fail === 0 ? 0 : 1;
    }

    for (const r of reports) {
      ctx.out(`${r.scope}\n`);
      for (const c of r.checks) {
        ctx.out(`  ${c.status.padEnd(4)}  ${c.name}: ${c.detail}\n`);
        if (c.fix && c.status !== "ok") {
          ctx.out(`        Fix: ${c.fix}\n`);
        }
      }

      ctx.out("\n");
    }

    ctx.out(
      `${summary.ok} ok, ${plural(summary.warn, "warning")}, ${plural(summary.fail, "failure")}\n`,
    );

    return summary.fail === 0 ? 0 : 1;
  },
});
