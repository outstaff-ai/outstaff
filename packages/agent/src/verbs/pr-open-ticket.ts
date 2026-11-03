import {
  applyActOps,
  PortError,
  policyValue,
  trackerMemberOf,
  type PullRequestToLink,
} from "@outstaff/core";
import type { TicketPrsResult } from "./office.types.js";
import type { AgentEnv, VerbContext } from "./types.js";

/** The parts of a pull request about to be opened that say which ticket it links to. */
interface Draft {
  headRef: string;
  title: string;
  body: string;
}

const onePerTicket = (env: AgentEnv) =>
  policyValue(env.team.policies, "tickets.prs_per_ticket") === "one";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The ticket the pull request would link to, by the rule the office links existing ones with, its status and what pull
 * requests it has; undefined without an office. With one pull request per ticket the office's answer is needed, so its
 * refusal fails the call; otherwise a refusal only costs the immediate link.
 */
export async function draftTicket(
  env: AgentEnv,
  draft: Draft,
): Promise<TicketPrsResult | undefined> {
  if (!env.office) {
    return undefined;
  }

  try {
    return await env.office.ticketPrs(draft);
  } catch (error) {
    if (onePerTicket(env)) {
      throw error;
    }

    env.log?.warn("could not ask the office which ticket the pull request is for", {
      error: message(error),
    });

    return undefined;
  }
}

/**
 * With one pull request per ticket (the default), a pull request for a ticket that already has an open one, or that is
 * done or canceled, is refused. A merged one does not count while the ticket is open: a follow-up fix after a merge
 * (for example for a check that failed on the merge commit) goes on the same ticket.
 */
export function oneForTicket(env: AgentEnv, found: TicketPrsResult | undefined): void {
  const { ticket, status, prs = [] } = found ?? {};
  if (!ticket || !onePerTicket(env)) {
    return;
  }

  if (status === "done" || status === "canceled") {
    throw new PortError(
      "conflict",
      `${ticket} is ${status}, so it takes no new pull request. File a follow-up ticket with \`ost ticket create --related ${ticket} --assignee me --status active --title "..."\` and open the pull request for that one, with \`Closes <new ticket>\` in its body.`,
    );
  }

  const open = prs.filter((p) => p.state === "open");
  if (open.length === 0) {
    return;
  }

  const named = open.map((p) => `${p.ref}${p.url ? ` ${p.url}` : ""}`).join(", ");
  throw new PortError(
    "conflict",
    `${ticket} already has an open pull request: ${named}. A ticket takes one open pull request at a time, because outstaff moves the ticket to done when its last open pull request merges and the checks on the merge pass. To change that pull request, use \`ost pr update\` or push to its branch. If this is a separate part, split the work: create a ticket for it with \`ost ticket create --parent ${ticket} --assignee me --status active --title "..."\`, then open the pull request for that new ticket, with \`Closes <new ticket>\` in its body.`,
  );
}

/**
 * Shows the pull request on its ticket in the tracker right away, as the caller, with the change the office's
 * `link_pr_on_ticket` makes when it sees the pull request (which then finds it linked). Returns the line that says so;
 * none when the tracker cannot link pull requests or the link failed, and the office's link then follows.
 */
async function linkOnTicket(env: AgentEnv, ticket: string, pr: PullRequestToLink) {
  const tracker = env.tracker;
  if (!tracker?.linkPullRequest) {
    return [];
  }

  const outcome = await applyActOps([{ op: "link_pr", ticket, pr }], { tracker }, (target) =>
    trackerMemberOf(target, env.team, tracker),
  );

  if (!outcome.ok) {
    env.log?.warn(`could not link the pull request on ${ticket}`, { error: outcome.error });
    return [];
  }

  return [`Linked on ${ticket}.`];
}

/**
 * After the pull request is opened: it is linked on its ticket, and the office is told the work item opened it, so
 * the item's hand-back gives that ticket to the requester too. The pull request exists already: a refusal costs only
 * that.
 */
export async function afterOpen(
  env: AgentEnv,
  ctx: VerbContext,
  pr: PullRequestToLink,
  ticket: string | undefined,
): Promise<string[]> {
  const lines = ticket ? await linkOnTicket(env, ticket, pr) : [];
  if (env.office && ctx.workItemId) {
    await env.office
      .workMade({ workItemId: ctx.workItemId, pr, ...(ticket ? { ticket } : {}) })
      .catch((error: unknown) => {
        env.log?.warn("could not tell the office about the pull request", {
          error: message(error),
        });
      });
  }

  return lines;
}
