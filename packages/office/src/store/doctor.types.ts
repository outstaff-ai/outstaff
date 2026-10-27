/** One finding of a doctor run, as the store takes it. Names are unique within one run of a scope. */
export interface NewDoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string | undefined;
  key?: string | undefined;
  adapter?: string | undefined;
}

/** A stored check: the latest finding of its scope's runs, and since when it has this status. */
export interface StoredDoctorCheck extends NewDoctorCheck {
  /** `office`, or the handle of the person whose agent reported it. */
  scope: string;

  /** When the check first reported its current status. */
  firstSeen: string;

  /** When a run last reported it. */
  lastSeen: string;
}

export interface DoctorStore {
  /**
   * Records one run of a scope's checks: a check keeps its first-seen time while its status stays the same, and a
   * check the run no longer reports is removed. A failing check so stays failing until a later run passes.
   */
  recordDoctorRun(scope: string, checks: NewDoctorCheck[]): Promise<void>;

  /** Every stored check, or one scope's, by scope and name. */
  listDoctorChecks(scope?: string): Promise<StoredDoctorCheck[]>;
}
