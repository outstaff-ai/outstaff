export type RoleOptions = {
  from?: string;
  title?: string;
  profile?: string;
  toolset?: string;
  force?: boolean;
};

/** The two files of a role: role.yaml and SKILL.md. */
export type RoleFiles = { yaml: string; skill: string };
