---
title: Network grants
description: Give an agent named HTTP services for ost http, and open the network path to the services and devices it needs.
---

What an agent can reach is decided by the deployment's network policy, not by Outstaff: inside its sandbox the agent runs `curl`, WebSocket clients in its own scripts, `nc` and declared tools such as `adb` like any other program (see [permissions](/guides/permissions/)). Who it acts as is decided by the accounts and credentials each person is given. A network grant names an HTTP service, per person or per role, for one convenience: `ost http` sends a request to it, with an optional bearer token the agent never sees.

Use `ost http` for a service that needs a token: the token stays out of the agent's environment and output. Reach a service without one however suits the work, for example a node script that opens a WebSocket and measures round trips.

This page covers the mechanics. How your team uses its services and devices (what an agent may change on them, who approves it) is your own convention, written in your repository like the rest ([Tell your agents how your repo works](/guides/repo-conventions/)).

## Grant a service

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
```

A person gets the grants of their role, then of each role in `extends`, then their own. A later grant with the same `name` replaces an earlier one, so a person can swap the token of a role's service. `roles` takes catalog role names.

| Field          | Meaning                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `http[].name`  | What the agent types: `ost http hub ...`.                                                                           |
| `http[].url`   | The origin only: scheme, host and optional port. A path, query or credentials are rejected (`network.invalid_url`). |
| `http[].token` | The name of a secret in the person's secrets. Sent as `Authorization: Bearer <value>`. Optional.                    |

The verb reaches only the granted origins. `ost validate` checks the names and URLs, and that a token does not reuse the name of a secret an integration reads (`network.reserved_token`), which would hand that credential to a service.

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

## Devices and other protocols

There is no grant and no verb per protocol. A device, a database or anything else the agent talks to over its own protocol is reached with that protocol's normal tool:

1. Declare the tool under `tools`, so every agent that needs it installs it at a pinned version ([Tools](/guides/tools/)).
2. Add `deny` rules for the commands it must never run. Deny always wins, and rules look past global options such as `adb -s <serial>`. The tools guide has a worked example for Android devices ([guarding a device](/guides/tools/#example-guarding-a-device)).
3. Open the network path from the agent to the device ([below](#open-the-network-path)), and give the agent its own account or key where the device has one.

A team file that still has `network.adb` fails validation (`schema.removed_key`) with a message that says so.

## Open the network path

Granting a service in `team.yaml` does not open the network, and leaving it out does not close it. The deployment's network policy decides what the agent reaches, with the verb or without it; `ost http` fails with a message that points at the network path when it is closed. On Kubernetes that is a NetworkPolicy; the [example policy](/guides/kubernetes/#network-policy) allows HTTPS to public addresses only and none of the private ranges. Add an egress rule for the agent pods and each service or device they need:

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
        - ipBlock: { cidr: 192.0.2.18/32 }
      ports:
        - { protocol: TCP, port: 5555 }
    - to:
        - ipBlock: { cidr: 192.0.2.5/32 }
      ports:
        - { protocol: TCP, port: 8123 }
```

The addresses are examples from the documentation range; use your own. A device whose port changes (Android wireless debugging, for example) needs the whole high port range to that one address. If only one agent has the grant, narrow the pod selector to that agent's pod with a label of your own. On Docker Compose, check that the agent's network can route to the hosts.

## Check it

- `ost validate` checks the grants as written.
- `ost doctor <handle>` checks the token secrets are present and that each HTTP origin answers (the token is not sent, so a `401` still counts as an answer). Inside the agent container an unreachable service is a failure; elsewhere it is a warning, because the path is only visible from the agent.
- `ost me` lists the services a person has been granted.

See the [agent verbs reference](/reference/agent-verbs/#http) for every option of `ost http`.
