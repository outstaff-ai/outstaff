---
title: Kubernetes
description: Run an office and one agent per person on Kubernetes with plain manifests, secrets as files, a network policy and sized resources.
---

The example in [`examples/k8s`](https://github.com/outstaff-ai/outstaff/tree/main/examples/k8s) is a kustomize base for the synthetic acme team. It uses plain manifests and no operator or chart. CI builds it with a pinned kustomize and validates every resource against the Kubernetes schemas with a pinned kubeconform.

## What you get

| Resource                 | Name                      | Notes                                                                                                         |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Namespace                | `outstaff-acme`           | Labelled for the `restricted` Pod Security level, which the manifests meet.                                   |
| Deployment, Service, PVC | `outstaff-office`         | One replica with `Recreate`, so two offices never share a store. The PVC holds SQLite if you use no Postgres. |
| StatefulSet              | `outstaff-agent-<handle>` | One per person, from one template, with a 20 GiB `home` volume claim each.                                    |
| NetworkPolicy            | several                   | Default deny; DNS and HTTPS out; agents to the office; the office to Postgres.                                |
| ConfigMap                | `outstaff-team`           | Generated from your `team.yaml`.                                                                              |
| Secrets (yours)          | see below                 | Not in the manifests. You create them.                                                                        |

Postgres is not included. Bring your own (a managed database, or your platform's Postgres operator) and give the office its URL in a Secret. Without one, the office stores its state in SQLite on its volume, which is fine to try things out.

## Layout

```text
examples/k8s/
  kustomization.yaml        namespace, resources, images, team ConfigMap
  namespace.yaml
  network-policy.yaml
  office/                   Deployment, Service, PVC
  agent/statefulset.yaml    the template of one agent
  people/<handle>/          nameSuffix, person label and two patches per person
```

A person is a folder with a `kustomization.yaml` that reuses `agent/`, adds `nameSuffix: -<handle>`, and patches two values: `OUTSTAFF_PERSON` and the name of the person's Secret. To add or remove a person, copy or delete a folder and edit the list in the top `kustomization.yaml`.

## Deploy

1. **Team file.** Copy your team file next to the kustomization: `cp .outstaff/team.yaml examples/k8s/team.yaml`. For acme, copy `examples/acme/.outstaff/team.yaml`. It is gitignored there.
2. **Images.** Set the release in the `images:` list of `kustomization.yaml`. Use a version tag, or a digest for fully reproducible rollouts.
3. **People.** Edit the list of `people/` folders to match your team file.
4. **Namespace.** `kubectl apply -f examples/k8s/namespace.yaml`.
5. **Secrets.** Create them as described below, or with the methods in the [Secrets guide](/guides/secrets/).
6. **Apply.** `kubectl apply -k examples/k8s`.
7. **Check.**

```sh
kubectl -n outstaff-acme get pods                      # office Ready 1/1, one agent pod per person Running
kubectl -n outstaff-acme logs deploy/outstaff-office | grep "agent connected"
kubectl -n outstaff-acme logs sts/outstaff-agent-sam   # why an agent does not start
```

## Secrets

The manifests expect these Secrets in the namespace. The keys listed are the acme example's (github, itsaplan, slack and claude-agent-sdk); yours depend on your `integrations`, and `ost setup office` and `ost setup <handle>` list them. Each key of a Secret becomes a file in `/run/secrets/outstaff`, which is where the containers look, so **the key names are the file names**.

| Secret                    | Keys                                                                                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outstaff-office`         | `GH_OFFICE_APP_ID`, `GH_OFFICE_APP_INSTALLATION_ID`, `GH_OFFICE_APP_PRIVATE_KEY`, `GH_OFFICE_APP_SLUG`, `ITSAPLAN_API_KEY`, `SLACK_OFFICE_BOT_TOKEN`, and `OUTSTAFF_AGENT_TOKEN_<HANDLE>` (upper case) for each person                                           |
| `outstaff-agent-<handle>` | `OUTSTAFF_AGENT_TOKEN` (the same value as the office's token for this person), `ANTHROPIC_API_KEY` (or your other sign-in), `GH_APP_ID`, `GH_APP_INSTALLATION_ID`, `GH_APP_PRIVATE_KEY`, `GH_APP_SLUG`, `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `ITSAPLAN_API_KEY` |
| `outstaff-office-store`   | `url`: the Postgres URL for the office, `postgres://user:password@host:5432/db`. Optional: without it the office uses SQLite on its volume.                                                                                                                      |

The agent pods mount their own Secret plus only the four `GH_OFFICE_APP_*` keys of the office Secret, in one directory. An agent never sees another person's secrets or the office's other keys.

With the files laid out as in `examples/compose/secrets/` (one folder per person and one for the office), plain `kubectl` creates all of it:

```sh
ns=outstaff-acme
office_args=(--from-file=secrets/office)
for p in priya tomas mira leo sam noor ines kofi; do
  kubectl -n $ns create secret generic outstaff-agent-$p --from-file=secrets/$p
  office_args+=(--from-file=OUTSTAFF_AGENT_TOKEN_$(echo $p | tr a-z- A-Z_)=secrets/$p/OUTSTAFF_AGENT_TOKEN)
done
kubectl -n $ns create secret generic outstaff-office "${office_args[@]}"
kubectl -n $ns create secret generic outstaff-office-store --from-literal=url='postgres://outstaff:...@db.internal:5432/outstaff'
```

A person's folder holds files that the office does not need (their Slack tokens, for example), and the office folder holds files an agent does not need; that is why the manifests mount selected keys and not whole Secrets. Files are mounted with mode `0440` and group `10001` (`fsGroup`), so only the container user reads them.

Kubernetes Secrets are base64 in etcd. Turn on encryption at rest, limit who can `get` secrets in the namespace, or let an external store fill them (see the Secrets guide). The pods do not mount a service account token, so nothing inside the cluster is reachable through the Kubernetes API from an agent.

## Hardening that is already in the manifests

- Every container is non-root (uid and gid 10001), with `readOnlyRootFilesystem`, all capabilities dropped, no privilege escalation and the `RuntimeDefault` seccomp profile. Writable places are the volumes: `/home/outstaff` (an agent), `/var/lib/outstaff` (the office) and a size-limited `emptyDir` for `/tmp`.
- `terminationGracePeriodSeconds` is 45 for the office and 60 for an agent. Both stop on `SIGTERM`: the office finishes its running handlers and an agent hands its work item back, so rolling either is safe.
- The office has a startup probe on `/healthz` with a generous window (three minutes), then a liveness probe on `/healthz` and a readiness probe on `/readyz`. The agent has no port, so no probes: it exits when it cannot run and the StatefulSet restarts it.

## Network policy

`network-policy.yaml` denies all traffic in the namespace, then allows:

- DNS to `kube-dns`;
- TCP 443 to the internet but not to private ranges or the cloud metadata address (`169.254.0.0/16`): the code host, tracker, chat service, LLM provider and tool sources;
- agents to the office on 8080, and nothing else into the office;
- the office to Postgres on 5432. The example allows `10.0.0.0/8`; put the address of your database, or delete the policy if you use SQLite.

This needs a CNI that enforces NetworkPolicy. HTTPS to any public address is broader than the allow-list in the [container contract](/reference/container-contract/) (an agent can run shell commands, and sockets do not ask the permission rules). If your CNI supports it, replace the `ipBlock` rule with FQDN rules for the hosts you name: `api.github.com`, `github.com`, your tracker, `slack.com` and its Socket Mode hosts, and `api.anthropic.com` or your cloud provider's model endpoint. Agents also need the hosts of the tool sources on their first start (the tools install into the home volume and later starts reuse them), so allow those temporarily or build an image with the tools in it ([Container images](/guides/images/)).

## Sizing

These are the starting points from the [container contract](/reference/container-contract/), set as requests, with a memory limit and no CPU limit so a build can use idle CPU. Watch the real use for a week, then adjust.

| Pod                         | Requests             | Memory limit  | Storage                                                                              |
| --------------------------- | -------------------- | ------------- | ------------------------------------------------------------------------------------ |
| Office                      | 0.5 CPU, 512 MiB     | 1 GiB         | 5 GiB volume for SQLite; none needed with Postgres                                   |
| Agent                       | 1 CPU, 2 GiB         | 4 GiB         | 20 GiB `home` volume                                                                 |
| Agent that builds and tests | 2 CPU, 4 GiB or more | 8 GiB or more | Size the volume for the clones and worktrees of every repository the person works in |

Give an agent that runs your tests the memory of your biggest test run, not of the agent. Raise it with a patch in that person's `people/<handle>/kustomization.yaml`, so one person can differ from the rest. Size the home volume for the installed tools, the clones and the worktrees, and cap `ephemeral-storage` so one runaway job cannot fill a node. The first start of an agent installs its tools and takes longer than later ones.

## Check it works

CI runs this for every pull request that touches `examples/`:

```sh
cp examples/acme/.outstaff/team.yaml examples/k8s/team.yaml
kustomize build examples/k8s | kubeconform -strict -summary -kubernetes-version 1.33.0 -
```
