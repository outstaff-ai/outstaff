---
title: "0017: Network and identity are the boundary, not verbs per protocol"
description: Devices and other protocols are reached with ordinary tools inside the pod; tool declarations take deny rules for what a tool must never run.
sidebar:
  order: 17
---

**Status:** accepted. Replaces the device parts of [0015](/decisions/0015-allow-by-default-in-the-sandbox/): the destructive `adb` and `fastboot` hard denies and `ost adb`.

## Context

[0015](/decisions/0015-allow-by-default-in-the-sandbox/) made the deployment's network policy and per-person identities the boundary, and let agents run any program. It still kept a verb for one protocol (`ost adb`, with `network.adb` grants for devices, pairing and remembered ports) and a built-in judge for destructive `adb` and `fastboot` commands. Each further protocol would have asked for its own verb, grant kind, doctor checks and built-in judge, all for one vendor's tool, while a team's own CLIs got nothing comparable: a tool declaration could narrow a tool to some commands but not keep it whole and refuse a few.

## Decision

- **No `ost` verb per protocol.** A device or service is reached with its normal tool inside the pod (`adb`, an SSH client, a vendor CLI), installed through a tools declaration. What it can reach is the deployment's network policy; who it acts as is the person's own account. `ost http` stays, since it keeps a bearer token out of the agent's environment.
- **`network.adb` is removed.** A team file that still uses it fails validation with a message pointing at the network policy and a tools declaration.
- **Tool declarations take `deny`**, in the same forms as `allow`. Deny always wins, over `allow` and over `all`. The commands a team never wants run on a device (factory reset, recovery reboots, flashing) are its own deny rules; the guides show the `adb` and `fastboot` ones as an example.
- **Rules find the subcommand after global options.** A tool can list `valued_options`, the options that take the next word as their value. A deny rule also tries each leading word that may be an option's value as not being the subcommand, so an undeclared global option cannot hide a denied command.

## Consequences

- The hard denies of 0015 no longer mention devices. A team that drives a device and wants guards writes them, and can tune them to its devices.
- Rules from every source match through leading global options the same way: a deny of `kubectl delete` now also catches `kubectl -n prod delete pod x`.
- A deny rule may refuse a command whose leading option took no value (`acmectl --verbose status delete` looks like `delete`). Listing `valued_options` makes matching exact.
