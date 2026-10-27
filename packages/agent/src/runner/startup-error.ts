/** Why the agent cannot start, in words an operator can act on. */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

export const present = (env: NodeJS.ProcessEnv, key: string): string => {
  const v = env[key];
  if (!v) {
    throw new StartupError(`${key} is not set.`);
  }

  return v;
};
