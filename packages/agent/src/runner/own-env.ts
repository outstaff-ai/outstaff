/**
 * Settings for the agent's own Node process. They are not the image's: the image's environment is also where the
 * agent's sessions start from, and a team's commands (tests, installs, builds) must not run with NODE_ENV=production.
 */
const OWN_ENV = { NODE_ENV: "production" } as const;

/**
 * Sets each of the agent's own settings the container does not set, and returns the keys it set: the runtime keeps
 * those out of the session's environment. A value the container sets is the team's choice and reaches the session.
 */
export function setOwnEnv(env: NodeJS.ProcessEnv): string[] {
  const set: string[] = [];
  for (const [key, value] of Object.entries(OWN_ENV)) {
    if (env[key] === undefined) {
      env[key] = value;
      set.push(key);
    }
  }

  return set;
}
