---
title: Concepts
description: The vocabulary used throughout Outstaff.
---

These are the terms the rest of the documentation relies on. Detailed pages will follow as each feature lands.

## Catalog

The catalog is the set of generic roles and skills that Outstaff ships. It is baked into the container images. A client can eject any part of it into their own repository and customize it.

## Role

A role describes a kind of job on a team, such as a developer or a reviewer: what the job is for, which skills it uses, and how it behaves. Roles come from the catalog or from the client's own repository.

## Team

A team is the group of humans and agents working for one client. It is described by `.outstaff/team.yaml` in the client repository: the humans, the people, the repositories with read and write grants, the integrations, the workflow, and the policies.

## Person

A person is one agent on the team, an instance of a role with a name. Each person runs in its own container and keeps a separate session, worktree and journal for every work item it handles.

## Human and trust

A human is a real person who works with the team. There is no special owner role, and trust is decided per channel. For code-host events such as reviews and comments, a trusted human is anyone with write access to the repository. In chat, a trusted human is any full member of the workspace, not a guest and not a bot. An optional `humans:` list narrows this to named people, which is recommended for large workspaces and open-source repositories. Anyone else's text is read as data, never as instructions.

## Work item

A work item is one unit of work the office schedules for a person: a ticket, a new review round on a pull request, a merge conflict, failing CI, a question from another agent, a chat request, or a scheduled job. The office tracks tickets, pull requests, CI runs and reviews as the state around it. Each work item keeps its own session, worktree and journal.

## Office

The office is the single container that runs a team. It takes in events by polling GitHub and the tracker or by receiving webhooks, keeps the work state, runs the workflow engine, schedules work for each person, routes questions between agents, and stores its state in Postgres or SQLite.
