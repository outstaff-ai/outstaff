import type { Capability } from "#/types.js";

/** A switch holds `true`/`false`, or one of a few named choices; `none` always means off. */
export type PolicyValue = boolean | string;

export interface PolicySwitch {
  /** Dotted path under `policies` in team.yaml. */
  path: string;

  /** Value when team.yaml says nothing. Everything that happens today is on by default. */
  default: PolicyValue;

  /** The value that turns the behaviour off (or, for a limit, lifts it). */
  off: false | "none" | "many" | "agent";

  /** What outstaff does while the switch is on, for `ost policies` and the docs. */
  behaviour: string;

  /** Who carries the behaviour out: code in the agent or the office, or an option the office reads. */
  kind: "agent" | "office" | "option";

  /** The capability the configured adapter needs for the switch to do anything; `validate` warns when it lacks it. */
  needs?: Capability;
}

/** The shape of `policies` the switches read; a parsed team config satisfies it. */
export type PolicyConfig = { [group: string]: unknown } | undefined;

/** Someone who submitted a review, as the host and the team know them. */
export interface ApproverCandidate {
  kind: "human" | "agent" | "automation";

  /** A human's login on the code host, or an agent's handle. */
  id: string;

  /** A human the team trusts (listed in `humans`, or with write access when it lists none). Ignored for agents. */
  trusted: boolean;
}

/** Where an effective value comes from: the built-in default or the team file. */
export type PolicySource = "default" | "team.yaml";

export interface PolicyReport {
  switch: PolicySwitch;

  /** What happens now. */
  value: PolicyValue;
  source: PolicySource;

  /** Why the value differs from what `policies` says, if it does. */
  note?: string;
}
