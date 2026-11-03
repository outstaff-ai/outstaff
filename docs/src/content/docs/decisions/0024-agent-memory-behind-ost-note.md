---
title: "0024: Agent memory is kept behind `ost note`, on the volume or in the knowledge base"
description: Agents read and change their notes only with ost note; the team file chooses whether they live on each agent's home volume or in the knowledge integration, where only versions by the agent or a trusted human are used.
sidebar:
  order: 24
---

**Status:** accepted. Replaces, from [0015](/decisions/0015-allow-by-default-in-the-sandbox/), the rule that the agent writes its memory folder with its tools.

## Context

An agent's memory, its lasting lessons and the team's preferences ([0010](/decisions/0010-context-per-work-item/)), were files in `memory/` on its home volume, written by the model with its edit tools. They were the only thing on the volume that could not be rebuilt, so every agent's volume needed persistence and backups for a few kilobytes. A human could not see or correct what an agent had learned without opening its volume, and a hosted offering would have had to keep a backed-up volume per agent for memory alone.

## Decision

- **One interface.** Agents read and change their notes only through `ost note` (`list`, `add`, `update`, `remove`), never by editing files. The policy no longer lets the runtime's tools write `memory/`. Every round, work item or chat session, starts with the notes in its prompt.
- **Two stores, chosen by `memory.store`.** `volume`, the default because it is how memory worked before, keeps the notes in `memory/notes.md`. `knowledge` keeps them through the knowledge port's `knowledge.notes` capability, apart from its documents; `ost validate` fails when the team's knowledge integration lacks it, and there is no fallback and no store in the office's database.
- **Trust.** A page in the knowledge base can be edited by others, and the notes are guidance in every run. A version is used only when the agent itself or a trusted human wrote it; otherwise the newest earlier version that one of them wrote, and the agent is told. The knowledge port never judges trust: the caller passes its rule.
- **Migration.** On a start where the store has no notes yet, the notes in the files of `memory/` are written to it; the files stay.
- **The office is told** of every change and of every ignored version (`notes_changed`), logs them, and records a notes page as the agent's document so comments on it reach the agent.

## Consequences

- With `store: knowledge` the home volume holds only rebuildable state and unpushed work, so a deployment can use a single-replica volume without backups; the catalog asks agents to push work in progress early, to a draft pull request.
- Humans read an agent's notes on its page, correct them as trusted humans, restore an old revision, or comment on them.
- An ignored version disappears from the live page at the agent's next change, which starts from the notes it uses; the page's revisions keep it.
- An ignored version shows in the office's log, not in the event pipeline's trace, which records pipeline events only.
