const SKILLS = /^skills\/([^/]+)\/SKILL\.md$/;

/**
 * Claude Code finds skills under `.claude/skills/<name>/SKILL.md` in the project directory. References, templates
 * and process documents are read by path from the skills, so they stay where they were rendered.
 */
export function workdirFiles(files: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, text] of files) {
    const skill = SKILLS.exec(path);
    out.set(skill ? `.claude/skills/${skill[1]}/SKILL.md` : path, text);
  }

  return out;
}
