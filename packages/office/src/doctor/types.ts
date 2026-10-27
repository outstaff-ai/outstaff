import type {
  AdapterRegistry,
  DoctorCheck,
  Logger,
  SecretSource,
  TeamConfig,
} from "@outstaff/core";
import type { LinkHealth } from "@outstaff/protocol";
import type { ComponentHealth } from "#/office.types.js";
import type { Store } from "#/store/types.js";
import type { Clock } from "#/types.js";

export interface OfficeDoctorOptions {
  team: TeamConfig;
  registry: AdapterRegistry;
  secrets: SecretSource;

  /** Where the office's secret files are, for the file mode checks and the fixes. */
  secretsDir: string;
  store: Pick<Store, "recordDoctorRun" | "listDoctorChecks">;
  clock: Clock;
  logger: Logger;

  /** Checks of the office's own ports to add to each run, such as the code host's merge rules. Default none. */
  extraChecks?: () => Promise<DoctorCheck[]>;

  /** What the adapters' checks call the providers with. Default the global fetch. */
  fetch?: typeof fetch;

  /** How long a run of the office's checks may take before it is given up; the stored checks stay. Default 60000. */
  runTimeoutMs?: number;
}

/** The doctor checks as the office runs and keeps them. It never throws and never posts anywhere. */
export interface OfficeDoctor {
  /** Runs the office's checks now and then every day at `office.doctor.daily_at`. */
  start(): void;

  /** Stops the daily runs and waits for a run in progress. */
  stop(): Promise<void>;

  /** Runs the office's checks now; joins a run already in progress. */
  run(): Promise<void>;

  /** Stores the checks a person's agent reported, replacing its earlier report. */
  report(person: string, checks: DoctorCheck[]): Promise<void>;

  /** Every stored check, failures first. */
  health(): Promise<LinkHealth>;

  /** When the office's own checks last finished, if they have. */
  lastRun(): string | undefined;

  /** The checks in short, for the office's health: visible, never fatal, never throws. */
  component(): Promise<ComponentHealth>;
}
