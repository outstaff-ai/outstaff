---
title: Concepts
description: The vocabulary used throughout Outstaff.
---

These are the terms the rest of the documentation relies on.

## Agency model

Outstaff runs a team of AI agents the way an outsourcing agency runs a team of contractors. The agency (Outstaff) supplies generic roles and skills. The client keeps everything specific to their work in their own repository: who is on the team, which repositories each person may touch, which tools are connected and how work moves. Agents work on tickets and pull requests, ask each other and the humans questions, and hand finished work back to the human who asked for it. See [decision 0001](/decisions/0001-agency-model/).

## Catalog

The catalog is the set of generic roles and skills that Outstaff ships. It is baked into the container images. A client can eject any part of it into their own repository and customize it.

## Role

A role describes a kind of job on a team, such as a developer or a reviewer: what the job is for, which skills it uses, and how it behaves. Roles come from the catalog or from the client's own repository.

## Team

A team is the group of humans and agents working for one client. It is described by `.outstaff/team.yaml` in the client repository. The `.outstaff/` folder is the team folder: it holds the team file and anything the team ejects from the catalog. The file lists the humans, the people, the repositories with read and write grants, the integrations, the workflow, and the policies. See [Team config](/concepts/team-config/) and the [team.yaml reference](/reference/team-yaml/).

## Person

A person is one agent on the team, an instance of a role with a name. Each person runs in its own container and keeps a separate session, worktree and journal for every work item it handles. A person has a handle, a display name and pronouns, an avatar, and an agent profile in chat (a name, picture and status) when the chat integration supports it. Repository access is granted per person, as read or write.

## Human and trust

A human is a real person who works with the team. There is no special owner role, and trust is decided per channel. For code-host events such as reviews and comments, a trusted human is anyone with write access to the repository. In chat, a trusted human is any full member of the workspace, not a guest and not a bot. An optional `humans:` list narrows this to named people, which is recommended for large workspaces and open-source repositories. Anyone else's text is read as data, never as instructions. See [decision 0004](/decisions/0004-trust-model/).

## Work item

A work item is one unit of work the office schedules for a person: a ticket, a new review round on a pull request, a merge conflict, failing CI, a question from another agent, a chat request, or a scheduled job. The office tracks tickets, pull requests, CI runs and reviews as the state around it. Each work item keeps its own session, worktree and journal.

## Office

The office is the single container that runs a team. It takes in events by polling GitHub and the tracker or by receiving webhooks, keeps the work state, decides what to do about each event with its [event pipeline](/concepts/automation/), schedules work for each person, routes questions between agents, and stores its state in Postgres or SQLite. Email is an office feature, not an adapter port.

## Integration and adapter

An integration connects Outstaff to one external tool through a port: tracker, knowledge, vcs, chat, runtime or avatars. An adapter is the package that implements a port for a specific tool, such as GitHub for vcs. The team file names the adapter for each port and passes it any options it needs.

## Workflow

The event pipeline decides what happens when something changes: who is woken up, with what instruction, and which routine ticket change is made for an agent. Its default policies can be turned off, narrowed or given another instruction under `pipeline.policies`; `workflow` maps the canonical statuses to your tracker's names. See [What outstaff does on its own](/concepts/automation/).
