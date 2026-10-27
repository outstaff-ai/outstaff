/** The single positional argument; undefined when there is none or more than one. */
export const onlyArg = (args: string[]): string | undefined =>
  args.length === 1 ? args[0] : undefined;
