import { z } from "zod";
import type { Verb, VerbField } from "./types.js";

type Prop = { type?: string; description?: string; default?: unknown; enum?: string[] };

/** The shape of a verb's input, read from its zod schema. */
export function describeVerb(verb: Verb): VerbField[] {
  const schema = z.toJSONSchema(verb.input, { io: "input", unrepresentable: "any" }) as {
    properties?: Record<string, Prop>;
    required?: string[];
  };

  return Object.entries(schema.properties ?? {}).map(([name, p]) => {
    const arg = verb.args.indexOf(name);
    const field: VerbField = {
      name,
      type: (p.type as VerbField["type"]) ?? "string",
      required: schema.required?.includes(name) ?? false,
      description: p.description ?? "",
    };

    if (p.default !== undefined) {
      field.default = p.default;
    }

    if (p.enum) {
      field.enum = p.enum;
    }

    if (arg >= 0) {
      field.arg = arg;
    }

    return field;
  });
}

export const cliPath = (verb: Verb): string[] => verb.cli ?? verb.name.split(".");

export const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
