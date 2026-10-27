import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLSeq } from "yaml";
import type { NewPerson, Removal } from "./types.js";

const OPTIONS = { lineWidth: 0, flowCollectionPadding: false } as const;

function open(yaml: string): Document {
  const doc = parseDocument(yaml);
  if (doc.errors.length > 0) {
    throw new Error(doc.errors[0]!.message);
  }

  return doc;
}

function peopleOf(doc: Document): YAMLSeq {
  const people = doc.get("people", true);
  if (!isSeq(people)) {
    throw new Error("The team file has no people list.");
  }

  return people;
}

/** Appends a person to `people`, keeping comments, quoting and the other sections as they are. */
export function addPerson(yaml: string, person: NewPerson): string {
  const doc = open(yaml);
  const people = peopleOf(doc);
  people.flow = false;
  const { handle, name, pronouns, role, model, repos, avatar } = person;
  people.add(
    doc.createNode({
      handle,
      name,
      pronouns,
      role,
      ...(model ? { model } : {}),
      repos,
      ...(avatar ? { avatar } : {}),
    }),
  );

  return doc.toString(OPTIONS);
}

function findStrings(value: unknown, needle: string, path: string[], out: string[]): void {
  if (value === needle) {
    out.push(path.join("."));
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findStrings(v, needle, [...path, String(i)], out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      findStrings(v, needle, [...path, k], out);
    }
  }
}

/** Removes a person, and the person from `policies.usage.shared` (a group left with one member is dropped). */
export function removePerson(yaml: string, handle: string): Removal | undefined {
  const doc = open(yaml);
  const people = peopleOf(doc);
  const at = people.items.findIndex((p) => isMap(p) && p.get("handle") === handle);
  if (at < 0) {
    return undefined;
  }

  people.delete(at);
  const usage: Removal["usage"] = [];
  const shared = doc.getIn(["policies", "usage", "shared"], true);
  if (isSeq(shared)) {
    for (let g = shared.items.length - 1; g >= 0; g--) {
      const group = shared.items[g];
      if (!isSeq(group)) {
        continue;
      }

      const before = group.items.map((i) => String(isScalar(i) ? i.value : i));
      if (!before.includes(handle)) {
        continue;
      }

      const after = before.filter((h) => h !== handle);
      if (after.length >= 2) {
        group.items = group.items.filter((i) => !(isScalar(i) && i.value === handle));
        usage.unshift({ before, after });
      } else {
        shared.items.splice(g, 1);
        usage.unshift({ before, after: null });
      }
    }

    if (shared.items.length === 0) {
      doc.deleteIn(["policies", "usage", "shared"]);
    }
  }

  const references: string[] = [];
  findStrings(doc.toJS(), handle, [], references);
  return { yaml: doc.toString(OPTIONS), usage, references };
}
