import { createOfficeConnection } from "@outstaff/agent";
import type { DoctorCheck, SecretSource } from "@outstaff/core";
import type { Context } from "../../types.js";

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

/** Is the office up, and does it accept this person's token? Only the handshake; the token is never printed. */
export async function officeChecks(
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
