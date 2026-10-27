import type { Capability } from "../types.js";
import type { TeamConfig, ValidationContext } from "./types.js";

/** A team being validated, with what is known about its adapters and catalog. */
export interface TeamCheck {
  config: TeamConfig;
  ctx: ValidationContext;

  /** Capabilities the adapters the team configured provide. */
  provided: Set<Capability>;

  /** Whether an adapter registry was given; without one nothing is known, so capability checks are skipped. */
  adaptersKnown: boolean;

  /** Whether a catalog was given, so role names can be checked. */
  checkRoles: boolean;
}
