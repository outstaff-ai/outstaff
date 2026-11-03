import {
  PortError,
  type DeriveContext,
  type DoctorCheck,
  type FieldEnsureOutcome,
  type SecretSource,
  type TrackerField,
  wantedTrackerFields,
} from "@outstaff/core";
import {
  connectItsaplan,
  type ApiCustomField,
  type ApiIssue,
  type Itsaplan,
} from "@outstaff/integration.shared.itsaplan";

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The project's custom fields. */
const listFields = (api: Itsaplan) =>
  api.http.request<ApiCustomField[]>("GET", `${api.projectPath}/custom-fields`);

/** The project's field of that name; a field of that name and another type is a conflict. */
async function findField(api: Itsaplan, field: TrackerField): Promise<ApiCustomField | undefined> {
  const found = (await listFields(api)).find((f) => same(f.name, field.name));
  if (found && found.fieldType !== field.type) {
    throw new PortError(
      "conflict",
      `The project's field "${found.name}" is a ${found.fieldType} field, not a ${field.type} field.`,
    );
  }

  return found;
}

/** Makes sure the project has the field; a field created at the same time by someone else counts as there. */
async function ensureField(api: Itsaplan, field: TrackerField): Promise<FieldEnsureOutcome> {
  if (await findField(api, field)) {
    return "exists";
  }

  try {
    await api.http.request("POST", `${api.projectPath}/custom-fields`, {
      body: { name: field.name, fieldType: field.type },
    });
  } catch (e) {
    if (e instanceof PortError && e.code === "conflict") {
      return "exists";
    }

    throw e;
  }

  return "created";
}

/** The number field of that name, or `not_found`. */
async function numberField(api: Itsaplan, name: string): Promise<ApiCustomField> {
  const found = await findField(api, { name, type: "number" });
  if (!found) {
    throw new PortError("not_found", `The project has no custom field "${name}".`);
  }

  return found;
}

/** A field's value as the issue carries it, as a number; null when it has none. */
function numberOf(issue: ApiIssue, fieldId: number): number | null {
  const value = issue.fieldValues?.find((v) => v.fieldId === fieldId)?.value;
  return value === undefined || value === null ? null : Number(value);
}

/** Capability `tracker.fields`: the project's custom number fields, by name. */
export function fieldHelpers(api: Itsaplan, fetchIssue: (key: string) => Promise<ApiIssue>) {
  return {
    ensureField: (field: TrackerField) => ensureField(api, field),

    async hasField(field: TrackerField) {
      return (await findField(api, field)) !== undefined;
    },

    async setField(key: string, name: string, value: number | null) {
      const issue = await fetchIssue(key);
      const field = await numberField(api, name);
      await api.http.request("PUT", `/issues/${issue.id}/fields/${field.id}`, { body: { value } });
    },

    async fieldValue(key: string, name: string) {
      const issue = await fetchIssue(key);
      return numberOf(issue, (await numberField(api, name)).id);
    },
  };
}

/** `ost setup --derive`: creates the fields the team wants (`usage.tracker_fields`) when the project lacks them. */
export async function prepareFields(secrets: SecretSource, ctx: DeriveContext): Promise<string[]> {
  const wanted = wantedTrackerFields(ctx.team);
  const apiKey = secrets.get("ITSAPLAN_API_KEY");
  if (wanted.length === 0 || !apiKey) {
    return [];
  }

  const { api } = await connectItsaplan(apiKey, ctx);
  const made: string[] = [];
  for (const field of wanted) {
    try {
      if ((await ensureField(api, field)) === "created") {
        made.push(`created the custom ${field.type} field "${field.name}"`);
      }
    } catch (e) {
      throw new Error(
        `could not create the custom field "${field.name}" (${(e as Error).message}); a project admin can add it as a ${field.type} field in the project's settings`,
        { cause: e },
      );
    }
  }

  return made;
}

/** `ost doctor`: the fields the team wants are in the project. */
export async function fieldChecks(api: Itsaplan, ctx: DeriveContext): Promise<DoctorCheck[]> {
  const wanted = wantedTrackerFields(ctx.team);
  if (wanted.length === 0) {
    return [];
  }

  const name = "Its a Plan usage fields";
  try {
    const fields = await listFields(api);
    const missing = wanted.filter(
      (w) => !fields.some((f) => same(f.name, w.name) && f.fieldType === w.type),
    );

    return missing.length === 0
      ? [
          {
            name,
            status: "ok",
            detail: `The project has ${wanted.map((w) => `"${w.name}"`).join(" and ")}.`,
          },
        ]
      : [
          {
            name,
            status: "warn",
            detail: `The project lacks the number field${missing.length === 1 ? "" : "s"} ${missing.map((m) => `"${m.name}"`).join(" and ")}, so agent tokens and cost stay in the office.`,
            fix: "Run `ost setup office --derive` with a key that may create custom fields, or add them as number fields in the project's settings; or set usage.tracker_fields to false.",
          },
        ];
  } catch (e) {
    return [
      {
        name,
        status: "warn",
        detail: `The project's custom fields could not be read: ${(e as Error).message}`,
        fix: "Let the member read the project's custom fields.",
      },
    ];
  }
}
