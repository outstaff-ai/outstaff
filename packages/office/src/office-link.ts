import type { PrRef } from "@outstaff/core";
import { createOfficeLink, type OfficeLink, type SubjectLinks } from "./link/index.js";
import type { ComponentHealth, CreateOfficeInput } from "./office.types.js";
import type { ProtocolServer } from "./protocol/index.js";
import type { OfficePorts } from "./types.js";
import type { Logger } from "@outstaff/core";

/** The office secret the office authenticates to the service at the other end of its link with. */
const LINK_TOKEN = "OUTSTAFF_LINK_TOKEN";

/** Where the office's adapters say tickets, pull requests and documents live, for the office link. */
export const subjectLinks = (ports: OfficePorts): SubjectLinks => ({
  ...(ports.tracker ? { ticket: (key: string) => ports.tracker!.links.issue(key) } : {}),
  pr: (pr: PrRef) => ports.vcs.links.pr(pr.repo, pr.number),
  ...(ports.knowledge ? { doc: (id: string) => ports.knowledge!.links.doc(id) } : {}),
});

/** The link's state for the office's health: visible, never fatal. */
export const linkHealth = (link: OfficeLink): ComponentHealth => {
  const s = link.status();
  return { ok: true, detail: s.lastError ? `${s.state}; ${s.lastError}` : s.state };
};

/**
 * Proposed (decision 0016): the office connects out to a monitoring or management service, when the team file names
 * one and the office has its token. Absent otherwise.
 */
export function createLinkForOffice(deps: {
  input: CreateOfficeInput;
  ports: OfficePorts;
  protocol: ProtocolServer;
  log: Logger;
}): OfficeLink | undefined {
  const { input, ports, protocol, log } = deps;
  const { team, store, clock } = input;
  const token = input.secrets.get(LINK_TOKEN);
  if (!team.link || !token) {
    return undefined;
  }

  return createOfficeLink({
    url: team.link.url,
    token,
    team,
    store,
    links: subjectLinks(ports),
    identity: {
      team: team.team.name,
      version: input.options?.officeVersion ?? "unknown",
      pipelineMode: team.office?.pipeline ?? "off",
    },
    connected: () => protocol.connected(),
    clock,
    logger: log,
  });
}
