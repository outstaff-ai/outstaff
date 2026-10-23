---
title: "0002: Ports and adapters"
description: Every integration is an adapter package behind a port.
sidebar:
  order: 2
---

**Status:** accepted

## Context

Teams use different issue trackers, docs tools, messengers, code hosts and LLM runtimes. If skills and scheduling code name a specific tool, every new tool means a fork.

## Decision

- Core code depends only on **ports**: TypeScript interfaces for Tracker, Knowledge, Vcs, Chat, Runtime, Avatars and Mail.
- Each integration is a separate **adapter package** that implements one port (for example `@outstaff/tracker-itsaplan`, `@outstaff/chat-slack`).
- Every port ships a **contract test kit**. An adapter is correct when it passes the kit, and the in-memory fakes used by core tests pass the same kits.
- Adapters declare **capabilities** (for example `tracker.webhooks`, `chat.homeView`).
  - `ost validate` compares them with what the team's roles need.
  - When something is missing it **warns** and explains what will not work. It never picks a fallback silently.
- Adapters expose **link templates** (issue, document, pull request and commit URLs), so agents always send links instead of bare ids.
- Skills never name a tool. Agents act through tracker-neutral `ost` verbs that map to ports.

## Consequences

- Adding a tool means adding one package and passing its kit. No changes to core or to the catalog.
- Tracker and Knowledge are optional ports, so a team can run without a tracker (see [0003](/decisions/0003-office-schedules-work/)).
- Some features depend on capabilities. For example, a home view exists only on chat platforms that have one.
