import { createOfficeConnection, type OfficeConnection } from "@outstaff/agent";
import type { DoctorCheck, SecretSource } from "@outstaff/core";
import type { Context } from "#/types.js";

const OFFICE_TIMEOUT_MS = 5_000;

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

type Rejection = NonNullable<ReturnType<OfficeConnection["rejection"]>>;

const TOKEN_CHECK = {
  key: "OUTSTAFF_AGENT_TOKEN",
  name: "Office accepts the agent token",
} as const;

const noOfficeUrl: DoctorCheck = {
  name: "Office reachable",
  status: "warn",
  detail: "OUTSTAFF_OFFICE_URL is not set, so the office was not contacted.",
  fix: "Set OUTSTAFF_OFFICE_URL to the office's WebSocket URL, for example ws://office:8080/agent.",
};

const badOfficeUrl = (url: string): DoctorCheck => ({
  name: "Office reachable",
  status: "fail",
  detail: `OUTSTAFF_OFFICE_URL "${url}" is not a URL.`,
  fix: "Use a ws:// or wss:// URL such as ws://office:8080/agent.",
});

const unreachable = (url: string, why: string): DoctorCheck => ({
  name: "Office reachable",
  status: "fail",
  detail: `office unreachable at ${url}${why ? ` (${why})` : ""}`,
  fix: "Check the office is running, OUTSTAFF_OFFICE_URL is right and the network allows the connection.",
});

/** The health address, or undefined when the office URL does not parse. */
function tryHealthUrl(env: Record<string, string | undefined>, url: string): string | undefined {
  try {
    return healthUrl(env, url);
  } catch {
    return undefined;
  }
}

/** What the health endpoint's status says: up, served elsewhere (404), or a failing part. */
function healthCheck(health: string, status: number, ok: boolean): DoctorCheck {
  if (ok) {
    return { name: "Office health", status: "ok", detail: `${health} answers ${status}.` };
  }

  if (status === 404) {
    return {
      name: "Office health",
      status: "warn",
      detail: `${health} answered 404; the office serves health on its own port.`,
      fix: "Set OUTSTAFF_OFFICE_HEALTH_URL to the office's health address, for example http://office:8081.",
    };
  }

  return {
    name: "Office health",
    status: "fail",
    detail: `${health} answered ${status}: the office is up but reports a failing part.`,
    fix: "Look at the office's logs.",
  };
}

/** Why the office turned the handshake down. */
function rejectedCheck(handle: string, rejection: Rejection): DoctorCheck {
  const auth = rejection.code === "auth_failed";
  const envName = `OUTSTAFF_AGENT_TOKEN_${handle.toUpperCase().replaceAll("-", "_")}`;
  return {
    ...TOKEN_CHECK,
    status: "fail",
    detail: auth
      ? `office rejected the agent token for ${handle}`
      : `office refused the connection of ${handle} (${rejection.code})`,
    fix: auth
      ? `Make OUTSTAFF_AGENT_TOKEN equal the office's ${envName}.`
      : "Run the same Outstaff version as the office.",
  };
}

/** Does the office complete the handshake with this person's token? */
async function tokenCheck(
  ctx: Context,
  url: string,
  handle: string,
  token: string,
): Promise<DoctorCheck> {
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

    return {
      ...TOKEN_CHECK,
      status: "ok",
      detail: `The office accepted the connection of ${handle}.`,
    };
  } catch {
    const rejection = conn.rejection();
    return rejection
      ? rejectedCheck(handle, rejection)
      : unreachable(url, "the handshake did not complete");
  } finally {
    clearTimeout(timer);
    await conn.stop();
  }
}

/** Is the office up, and does it accept this person's token? Only the handshake; the token is never printed. */
export async function officeChecks(
  ctx: Context,
  secrets: SecretSource,
  handle: string,
): Promise<DoctorCheck[]> {
  const url = ctx.env["OUTSTAFF_OFFICE_URL"] || secrets.get("OUTSTAFF_OFFICE_URL");
  if (!url) {
    return [noOfficeUrl];
  }

  const health = tryHealthUrl(ctx.env, url);
  if (health === undefined) {
    return [badOfficeUrl(url)];
  }

  let healthy: DoctorCheck;
  try {
    const res = await (ctx.fetch ?? fetch)(health, {
      signal: AbortSignal.timeout(OFFICE_TIMEOUT_MS),
    });

    healthy = healthCheck(health, res.status, res.ok);
  } catch (e) {
    return [unreachable(url, (e as Error).name === "TimeoutError" ? "timed out" : "")];
  }

  const token = secrets.get("OUTSTAFF_AGENT_TOKEN");
  return token ? [healthy, await tokenCheck(ctx, url, handle, token)] : [healthy];
}
