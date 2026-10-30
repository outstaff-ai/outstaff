---
title: Guides
description: Task-oriented how-to guides.
---

Outstaff does not host itself and does not store your secrets ([0008](/decisions/0008-hosting-and-secrets-out-of-scope/)). These guides show how to run the containers well, on a platform of your choice. Each one is written so you, or an assistant working for you, can follow it step by step, and the examples they use are tested in CI.

Every deployment guide builds on the [container contract](/reference/container-contract/): the environment variables, secret files, volumes, ports, health checks and egress each container needs.

- [Container images](/guides/images/): what is in the `agent` and `office` images, how tools get into an agent, how to extend an image.
- [Docker Compose](/guides/compose/): the acme team on one Docker host, with Postgres.
- [Kubernetes](/guides/kubernetes/): the same team as plain manifests, with secrets, a network policy and resource sizing.
- [Secrets](/guides/secrets/): keep the secret files in 1Password, SOPS, Kubernetes Secrets or Compose secrets.
- [Tell your agents how your repo works](/guides/repo-conventions/): put your commit, branch and pull request rules in the repository, and what to do when its files cannot change.
- [Permissions](/guides/permissions/): what agents may run, the short list of hard denies, and the boundary an operator provides around them.
- [Network grants](/guides/network-grants/): name HTTP services for `ost http`, and open the network path to services and devices.
- [Runtimes](/guides/runtimes/): the runtime and model each person runs on, what is checked per person, and which runtimes an image carries.
- [Design canvas](/guides/design-canvas/): let the designer work on a private Claude Design canvas, and what it needs.
- [Writing a policy](/guides/writing-a-policy/): add behaviour to the office as a policy of your own, loaded from team.yaml and tested by replaying events.
- [Hire and remove people](/guides/hiring/): add a person with `ost hire`, which generates what you leave out, and remove one with `ost fire`.
