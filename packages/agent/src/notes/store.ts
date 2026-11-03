import { PortError, notesTrust, type KnowledgeNotes, type NotesOwner } from "@outstaff/core";
import { requireKnowledge } from "#/verbs/support.js";
import type { AgentEnv } from "#/verbs/types.js";
import type { NotesStore } from "./types.js";
import { volumeNotes } from "./volume.js";

/** The notes in the knowledge base, as the agent's own and with the team's trust. */
function knowledgeStore(env: AgentEnv): NotesStore {
  const notes: KnowledgeNotes | undefined = requireKnowledge(env).notes;
  if (!notes) {
    throw new PortError(
      "unsupported",
      "memory.store is knowledge, but the knowledge integration does not keep notes (knowledge.notes).",
    );
  }

  const me = env.team.people.find((p) => p.handle === env.person);
  const owner: NotesOwner = {
    name: me?.name ?? env.person,
    trusted: notesTrust(env.team, env.person),
  };

  return {
    kind: "knowledge",
    read: () => notes.read(owner),
    write: (list, version) => notes.write(owner, list, version),
  };
}

/** Where this agent's notes are kept: `memory.store` in the team file, the volume by default. */
export function notesStore(env: AgentEnv): NotesStore {
  if (env.team.memory?.store === "knowledge") {
    return knowledgeStore(env);
  }

  if (!env.layout) {
    throw new PortError("unsupported", "No home directory is known, so the notes cannot be found.");
  }

  return volumeNotes(env.layout.memoryDir);
}
