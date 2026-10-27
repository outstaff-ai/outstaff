import type { CommandDef, OptionDef } from "./types.js";

export function defineCommand<O>(def: CommandDef<O>): CommandDef {
  return def as unknown as CommandDef;
}

export const GLOBAL_OPTIONS: OptionDef[] = [
  {
    flags: "--team <path|git-url>",
    description:
      "Team config to use: a file, a directory, or a git URL with an optional #ref. Defaults to OUTSTAFF_TEAM_FILE, OUTSTAFF_TEAM_REPO, then .outstaff/team.yaml or team.yaml in the current directory or the nearest parent up to the git root.",
  },
  { flags: "--json", description: "Print machine-readable JSON instead of text." },
  { flags: "-v, --version", description: "Print the version." },
  { flags: "-h, --help", description: "Show help." },
];
