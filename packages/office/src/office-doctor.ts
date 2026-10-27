import { mergeGateChecks, type Logger, type Vcs } from "@outstaff/core";
import { createOfficeDoctor, type OfficeDoctor } from "./doctor/index.js";
import type { CreateOfficeInput } from "./office.types.js";

/** Where the containers read secret files when `OUTSTAFF_SECRETS_DIR` does not say otherwise. */
export const DEFAULT_SECRETS_DIR = "/run/secrets/outstaff";

/** The office's doctor, on the office's own team, secrets and store; it also reads the code host's merge rules. */
export const doctorForOffice = (input: CreateOfficeInput, vcs: Vcs, log: Logger): OfficeDoctor =>
  createOfficeDoctor({
    team: input.team,
    registry: input.registry,
    secrets: input.secrets,
    secretsDir: input.options?.secretsDir ?? DEFAULT_SECRETS_DIR,
    store: input.store,
    clock: input.clock,
    logger: log,
    extraChecks: () => mergeGateChecks(input.team, vcs),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
