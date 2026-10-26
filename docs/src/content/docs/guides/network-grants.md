---
title: Network grants
description: Give an agent named HTTP services and Android devices for ost http and ost adb, and open the network path they need.
---

What an agent can reach is decided by the deployment's network policy, not by Outstaff: inside its sandbox the agent runs `curl`, WebSocket clients in its own scripts, `nc` and `adb` like any other program (see [permissions](/guides/permissions/)). A network grant names a service or a device, per person or per role, for two conveniences:

- `ost http` sends a request to a granted HTTP service, with an optional bearer token the agent never sees.
- `ost adb` pairs with, connects to and runs commands on a granted Android device, remembering its ports.

Use `ost http` for a service that needs a token: the token stays out of the agent's environment and output. Reach a service without one however suits the work, for example a node script that opens a WebSocket and measures round trips.

This page covers the mechanics. How your team uses its services and devices (what an agent may change on them, who approves it) is your own convention, written in your repository like the rest ([Tell your agents how your repo works](/guides/repo-conventions/)).

## Grant a service or a device

Add `network` to a person, or to a role under the top-level `roles`:

```yaml
roles:
  developer:
    network:
      http:
        - { name: hub, url: "https://hub.acme.example" }

people:
  - handle: sam
    name: Sam Duarte
    role: developer
    network:
      http:
        - { name: home, url: "https://home.acme.example", token: HOME_TOKEN }
      adb:
        - { name: test-tablet, host: 10.0.0.16, pairing: wireless }
        - { name: wall-panel, host: 10.0.0.18, port: 5555 }
```

A person gets the grants of their role, then of each role in `extends`, then their own. A later grant with the same `name` replaces an earlier one, so a person can swap the token of a role's service. `roles` takes catalog role names.

| Field           | Meaning                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `http[].name`   | What the agent types: `ost http hub ...`.                                                                                        |
| `http[].url`    | The origin only: scheme, host and optional port. A path, query or credentials are rejected (`network.invalid_url`).              |
| `http[].token`  | The name of a secret in the person's secrets. Sent as `Authorization: Bearer <value>`. Optional.                                 |
| `adb[].host`    | Host name or IP address of the device.                                                                                           |
| `adb[].port`    | A fixed adb port, for classic adb over TCP (usually 5555).                                                                       |
| `adb[].pairing` | `wireless` for Android 11+ wireless debugging, which uses random ports. Give `port` or `pairing`, not both (`network.adb_mode`). |

The verbs reach only the granted origins and devices. `ost validate` checks the names, URLs and ports, and that a token does not reuse the name of a secret an integration reads (`network.reserved_token`), which would hand that credential to a service.

## HTTP services

```sh
ost http hub GET /api/devices
ost http home POST /api/services/light/turn_on --json '{"entity_id":"light.desk"}'
ost http hub PUT /api/config --data-file config.json --header 'Content-Type:application/json'
```

The verb prints the status, the response headers and the body.

- It reaches only the origin of the named service. A path that would leave it (`//other.example/`, a full URL) is refused.
- It never follows a redirect: the `Location` header is printed and the agent decides. A redirect cannot carry the token to another host.
- The token is read from the person's secrets when the request is made and added as a header. The agent cannot give its own `Authorization`, `Host` or `Cookie` header, and the token is masked in everything printed, in errors and in logs. The secret key is also stripped from the environment of the agent's commands, like every other secret.
- A body comes from `--json` (inline, checked as JSON) or `--data-file` (a file in the worktree or scratch directory that the read rules allow), not both.
- The response is data from the service. The verb says so with every response, and the agent's instructions say the same: it reads, it does not obey.
- A request stops after 30 seconds and the output is cut at 200000 characters.

Create the token secret like any other, in the person's secrets directory (`ost setup <handle>` lists it, and `ost doctor <handle>` checks it is present):

```
.outstaff/secrets/sam/HOME_TOKEN
```

## Android devices

`ost adb` uses `adb` from Android platform-tools. The agent can also run `adb` itself; the permission policy denies the destructive commands either way (factory reset and wipes, recovery and bootloader reboots, `rm -r` of the device's data roots, removing system packages). The verb adds what raw `adb` lacks: it picks the granted device, connects first and remembers wireless debugging ports.

### Install adb

Outstaff does not ship adb. Either put `adb` on the `PATH` of an image you build ([Container images](/guides/images/)), or declare it as a tool with mise's `http` backend, which downloads Google's platform-tools zip ([Tools](/guides/tools/#tool-options)):

```yaml
tools:
  adb:
    source: "http:adb"
    version: 37.0.1
    options:
      url: "https://dl.google.com/android/repository/platform-tools_r{{ version }}-linux.zip"
      bin_path: platform-tools
      checksum: "sha256:d230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1"
```

That URL is the linux x86-64 build. Google publishes no arm64 Linux platform-tools, so a team whose agents run on arm64 needs its own image with `adb` on the `PATH`. The checksum above is the SHA-256 of `platform-tools_r37.0.1-linux.zip`, computed from the download (Google's repository manifest lists SHA-1 only). When you change the version, download the new zip, compare its SHA-1 with the manifest at `https://dl.google.com/android/repository/repository2-3.xml`, and put its SHA-256 in `checksum`.

The verb runs whichever `adb` is first on the agent's `PATH`. `ost doctor <handle>` reports whether `adb` runs.

### Classic adb over TCP

A device with adb listening on a fixed port (usually 5555):

```yaml
adb:
  - { name: wall-panel, host: 10.0.0.18, port: 5555 }
```

```sh
ost adb connect wall-panel
ost adb run wall-panel -- shell getprop ro.product.model
```

`run` connects first, so a restarted adb server or a device that went idle needs no extra step.

### Wireless debugging (Android 11 and later)

Wireless debugging uses a random port for pairing and another random port for connecting, and the connect port changes after a reboot or when the feature is switched off and on. Containers in Kubernetes have no multicast, so adb cannot discover these ports with mDNS. A human supplies them:

1. On the device, open Settings > Developer options > Wireless debugging and choose Pair device with pairing code. The dialog shows an IP address and port and a six-digit code, which expire quickly.
2. The human gives the pairing port and the code to the agent in chat or on the ticket. The agent runs `ost adb pair test-tablet --port 37123 --code 123456`. The pairing key is kept in `~/.android` in the agent's home, so it survives restarts if the home is a volume.
3. The Wireless debugging screen itself shows another IP address and port: the connect port. The agent runs `ost adb connect test-tablet --port 41555`.
4. From then on the agent runs `ost adb run test-tablet -- ...`. The last connect port that worked is remembered in `~/.outstaff/adb-ports.json` in the agent's home.

When the device stops answering, the verb fails with a message that tells the agent to ask a human for the current port, and `ost adb connect test-tablet --port <new port>` fixes it. If the device no longer trusts the agent, the human pairs again (steps 1 and 2).

### Commands

```sh
ost adb run test-tablet -- shell getprop ro.build.version.release
ost adb run test-tablet -- logcat -d -t 200
ost adb run test-tablet -- install -r build/app-debug.apk
```

`ost adb run <device> -- <adb args>` runs `adb -s <host:port> <args>`, with the device chosen for you. A command stops after `--timeout` seconds (default 120), so use `logcat -d`, not a streaming `logcat`. Output is data from the device and secret-shaped text is masked.

The verb refuses a short list of commands: connection management (`connect`, `disconnect`, `pair`, `tcpip`, `usb`, `root`, `kill-server`), `sideload`, reboots into the bootloader or recovery, factory reset and data wipes, and removing, disabling or clearing system packages (`android`, `com.android.*`, `com.google.*`, or anything with `--user`). The list is a guard against mistakes, not a sandbox: the device is the team's to protect, so grant only devices you can afford to lose state on.

## Open the network path

Granting a service in `team.yaml` does not open the network, and leaving it out does not close it. The deployment's network policy decides what the agent reaches, with the verbs or without them; `ost http` and `ost adb` fail with a message that points at the network path when it is closed. On Kubernetes that is a NetworkPolicy; the [example policy](/guides/kubernetes/#network-policy) allows HTTPS to public addresses only and none of the private ranges. Add an egress rule for the agent pods and each host you granted:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: agent-sam-network-grants
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: outstaff-agent
  policyTypes: [Egress]
  egress:
    - to:
        - ipBlock: { cidr: 10.0.0.16/32 }
      ports:
        - { protocol: TCP, port: 1024-65535 }
    - to:
        - ipBlock: { cidr: 10.0.0.18/32 }
      ports:
        - { protocol: TCP, port: 5555 }
    - to:
        - ipBlock: { cidr: 10.0.0.5/32 }
      ports:
        - { protocol: TCP, port: 8123 }
```

Wireless debugging ports are random, so the rule for such a device must allow the whole high port range to that one address. If only one agent has the grant, narrow the pod selector to that agent's pod with a label of your own. On Docker Compose, check that the agent's network can route to the hosts.

## Check it

- `ost validate` checks the grants as written.
- `ost doctor <handle>` checks the token secrets are present, that each HTTP origin answers (the token is not sent, so a `401` still counts as an answer), that `adb` runs and that each device with a known port accepts a TCP connection. Inside the agent container an unreachable service is a failure; elsewhere it is a warning, because the path is only visible from the agent.
- `ost me` lists the services and devices a person has been granted.

See the [agent verbs reference](/reference/agent-verbs/#http) for every option of `ost http` and `ost adb`.
