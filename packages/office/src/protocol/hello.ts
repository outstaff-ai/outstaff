import { PROTOCOL_VERSION, type MessageOf } from "@outstaff/protocol";
import { CLOSE_AUTH, CLOSE_REPLACED, CLOSE_VERSION } from "./constants.js";
import type { Connection, HelloContext } from "./types.js";

/** Authenticates a new connection, replaces an older one of the same person and sends the `welcome`. */
export async function handleHello(
  ctx: HelloContext,
  c: Connection,
  m: MessageOf<"hello">,
): Promise<void> {
  const { opts, conns, heartbeatMs, log, send, sendError, armIdle, connected } = ctx;
  const { source, auth } = opts;
  const { person, token, protocolVersion } = m.payload;
  if (protocolVersion !== PROTOCOL_VERSION) {
    sendError(
      c,
      "version_mismatch",
      `Protocol version ${protocolVersion} is not supported; this office speaks ${PROTOCOL_VERSION}.`,
      m.id,
    );

    c.ws.close(CLOSE_VERSION, "version mismatch");
    return;
  }

  if (!(await auth.verify(person, token))) {
    log.warn("agent authentication failed", { person });
    sendError(c, "auth_failed", "Unknown person or wrong token.", m.id);
    c.ws.close(CLOSE_AUTH, "authentication failed");
    return;
  }

  if (c.ws.readyState !== c.ws.OPEN) {
    return;
  }

  const old = conns.get(person);
  c.person = person;
  conns.set(person, c);
  if (old) {
    sendError(old, "replaced", "Another connection for this person took over.");
    old.ws.close(CLOSE_REPLACED, "replaced");
  }

  armIdle(c, heartbeatMs * 3);
  const outstanding = await source.outstanding(person);
  // Reports the agent was offline for are handed to it here, once; it posts them as itself.
  const reports = await opts.chat?.queued(person).catch((err: unknown) => {
    log.warn("could not collect the queued reports of an agent", { person, error: String(err) });
    return [];
  });

  send(
    c,
    "welcome",
    {
      protocolVersion: PROTOCOL_VERSION,
      heartbeatMs,
      team: opts.team,
      resume: outstanding.filter((o) => o.accepted).map((o) => o.offer.workItem.id),
      ...(reports?.length ? { reports } : {}),
    },
    m.id,
  );

  log.info("agent connected", { person });
  connected(person);
}
