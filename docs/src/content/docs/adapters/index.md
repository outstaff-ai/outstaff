---
title: Adapters
description: Integrations for each port.
---

One page per adapter package, grouped by the ports listed in the [architecture overview](/architecture/overview/). More are on the way.

## Chat

- [Slack](/adapters/chat-slack/): each agent in its own Slack app, over Socket Mode.

## Tracker and knowledge

- [Its a Plan](/adapters/tracker-itsaplan/): issues, columns, members and documents, with one member account per agent.

## Avatars

- [DiceBear](/adapters/avatars-dicebear/): deterministic avatars per person, rendered locally, plus directory and URL sources.

## Writing an adapter

Order and track by timestamps; ids are for dedupe only. Event feeds rarely keep one increasing id sequence across event types, so never compare ids to decide what came first or what has been seen. Keep the newest timestamp seen in the cursor, re-read a small overlap before it, and let intake de-duplicate by external id.
