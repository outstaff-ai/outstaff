import { PortError, type TrackerField } from "#/ports/index.js";
import type { FakeTracker } from "./types.js";

const keyOf = (name: string) => name.trim().toLowerCase();

/**
 * The fake's custom fields: the project's fields by name (`fields`), and the values set on each ticket with who set
 * them (`fieldValues`, by ticket key, then field name).
 */
export function fakeFields(need: (key: string) => unknown, actor: () => string) {
  const fields: FakeTracker["fields"] = new Map();
  const fieldValues: FakeTracker["fieldValues"] = new Map();

  const typed = (field: TrackerField) => {
    const found = fields.get(keyOf(field.name));
    if (found && found.type !== field.type) {
      throw new PortError("conflict", `Field ${found.name} is a ${found.type} field.`);
    }

    return found;
  };

  const named = (name: string) => {
    const found = fields.get(keyOf(name));
    if (!found) {
      throw new PortError("not_found", `No custom field ${name}.`);
    }

    return found;
  };

  return {
    fields,
    fieldValues,

    async ensureField(field: TrackerField) {
      if (typed(field)) {
        return "exists" as const;
      }

      fields.set(keyOf(field.name), { ...field });
      return "created" as const;
    },

    async hasField(field: TrackerField) {
      return typed(field) !== undefined;
    },

    async setField(key: string, name: string, value: number | null) {
      need(key);
      const field = named(name);
      const values = fieldValues.get(key) ?? new Map();
      values.set(field.name, { value, by: actor() });
      fieldValues.set(key, values);
    },

    async fieldValue(key: string, name: string) {
      need(key);
      return fieldValues.get(key)?.get(named(name).name)?.value ?? null;
    },
  };
}
