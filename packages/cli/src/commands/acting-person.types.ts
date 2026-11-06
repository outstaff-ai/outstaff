import type { Profile, TeamConfig, Vcs } from "@outstaff/core";

/** The person a credential command acts as, their role's profile and their code host. */
export interface ActingPerson {
  team: TeamConfig;
  person: string;
  profile: Profile;
  vcs: Vcs;
}
