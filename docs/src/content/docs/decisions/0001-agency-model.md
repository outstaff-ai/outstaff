---
title: "0001: The agency model"
description: Outstaff is modelled on an outsourcing agency.
sidebar:
  order: 1
---

**Status:** accepted

## Context

A team of AI agents needs the same things a team of contractors does. Each needs a job description, a name and accounts, access to the right repositories, a way to receive work, and someone keeping the work moving. Built ad hoc for one product, these end up hard-coded into scripts and prompts that nobody else can reuse.

## Decision

Outstaff works like an outsourcing agency:

- **Catalog:** the agency's bench of roles and skills, versioned and shipped with the framework.
- **Team:** one client engagement, described in `.outstaff/team.yaml` in the client's repository.
- **Person:** one agent on the team. It is an instance of a catalog role with a name, pronouns, an avatar and repository grants.
- **Human:** a real person working with the team (see [0004](/decisions/0004-trust-model/)).
- **Office:** the team's hub, which takes in events and schedules work (see [0003](/decisions/0003-office-schedules-work/)).

## Consequences

- A client repository holds configuration, not framework code.
- Hiring is a command (`ost hire <role>`) that adds a person to the team config and walks through their setup.
- Everything product-specific lives in the team config, or in catalog files the client has ejected.
