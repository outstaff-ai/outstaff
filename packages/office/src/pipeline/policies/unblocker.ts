import type { Resolved } from "@outstaff/core";
import type { PolicyContext } from "@outstaff/policy";

/** The team's PM, who unblocks a blocked hand-back; nobody when the team has none or the PM is the blocked agent. */
export function unblocker(ctx: PolicyContext): Resolved<string> {
  const pm = ctx.person("role:pm");
  if ("skip" in pm) {
    return pm;
  }

  return pm.value === ctx.event.actor.id
    ? { skip: `the blocked agent, ${pm.value}, is the team's PM` }
    : pm;
}
