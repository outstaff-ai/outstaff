---
title: Sponsors
description: What sponsoring Outstaff funds, the tiers, and how sponsor logos appear and update.
---

Outstaff is open source under the Apache License 2.0 and free to use. [GitHub Sponsors](https://github.com/sponsors/outstaff-ai) on the `outstaff-ai` organization funds the work that keeps it dependable.

## What it funds

- Maintenance: reviewing issues and pull requests, and keeping dependencies and runtimes current.
- Releases: the packages and the `office` and `agent` container images.
- The catalog of roles and skills, the adapters, and these docs.
- The CI that runs the example team end to end on every change.

## Tiers

Monthly amounts; a one-time sponsorship is also possible.

| Tier      | Per month | What you get                                             |
| --------- | --------- | -------------------------------------------------------- |
| Supporter | $5        | Your name in the sponsors image                          |
| Backer    | $25       | A small avatar in the sponsors image                     |
| Bronze    | $100      | A small logo in the README and on this site              |
| Silver    | $500      | A medium logo in the README and on the docs home page    |
| Gold      | $1,500    | A large logo at the top, and a line in the release notes |

The tiers themselves live on GitHub, so the dashboard is the source of truth for amounts and perks.

## How logos appear

The image in the README is generated from the GitHub Sponsors API with [sponsorkit](https://github.com/antfu-collective/sponsorkit) when this site is built, grouped by tier, with past sponsors in a smaller group at the end. It is published at `/sponsors.svg` and `/sponsors.png`. Nothing is edited by hand.

The site is rebuilt every Monday at 06:00 UTC and on every merge to `main`, so a new sponsor shows up within a week, usually sooner. Until there is a sponsor, the image invites you to be the first.
