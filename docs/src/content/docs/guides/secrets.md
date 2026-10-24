---
title: Secrets
description: Keep Outstaff's secrets in 1Password, SOPS, Kubernetes Secrets or Compose secrets, and always end with files under /run/secrets/outstaff.
---

Outstaff does not store or broker your secrets ([0008](/decisions/0008-hosting-and-secrets-out-of-scope/)). The office and each agent read a secret named `KEY` from the file `/run/secrets/outstaff/KEY`, and fall back to an environment variable only on platforms that can inject nothing else. The directory can be moved with `OUTSTAFF_SECRETS_DIR`. A trailing newline is trimmed and an empty file counts as missing.

> The key names in these guides are those of the acme example's adapters (github, itsaplan, slack and claude-agent-sdk). Each adapter declares its own secrets, so your list comes from your `integrations`: run `ost setup office` and `ost setup <handle>` to get the exact keys for your team. The mechanics below do not depend on the keys: every secret ends up as a file `/run/secrets/outstaff/<KEY>`.

So every method below has the same last step: **get one file per secret into that directory, readable by the container user (uid 10001) and nobody else.** Where the values live before that, and who may read them, is your choice.

:::caution
Do not pass secrets as environment variables. An agent's shell inherits its container's environment, so a secret in `environment:` or a plain `env:` entry is one `printenv` away. Outstaff scrubs the keys it knows from the agent's shell, but files are the only way that does not depend on that.
:::

## Which files, and who needs them

The [container contract](/reference/container-contract/) lists every key with the container that needs it and where its value comes from. For the acme example (GitHub, Slack, the Its a Plan tracker and the Claude Agent SDK):

- the **office** needs `OUTSTAFF_AGENT_TOKEN_<HANDLE>` for each person, the four `GH_OFFICE_APP_*` keys, `ITSAPLAN_API_KEY` and `SLACK_OFFICE_BOT_TOKEN` (the office has its own Slack bot token and never uses an agent's);
- each **agent** needs its own `OUTSTAFF_AGENT_TOKEN` (the same value the office holds for that person), a model sign-in (`ANTHROPIC_API_KEY`, or another way the contract lists), its own `GH_APP_*` keys, its own Slack and tracker credentials, and the four `GH_OFFICE_APP_*` keys.

`ost setup` writes a template that lists these keys with a note on where each value comes from, and fills in the ones it can look up. Creating the apps and accounts stays manual.

The methods below use one layout, the one `ost setup` and `ost doctor` use by default (in your repository under `.outstaff/secrets/`, git-ignored) and `examples/compose/secrets/` uses: `secrets/office/<KEY>` and `secrets/<handle>/<KEY>`. The paths below are relative to that secrets root: run them from `.outstaff/`, or set Compose's `SECRETS_DIR` to `.outstaff/secrets`. The Compose example mounts these files directly, and the Kubernetes guide builds Secrets from them.

## Docker Compose secrets

Compose `secrets:` with a `file:` source bind-mounts a host file read-only into the containers that list it. The example maps each to `/run/secrets/outstaff/<KEY>` with a long-syntax `target`:

```yaml
services:
  sam:
    secrets:
      - { source: sam_GH_APP_ID, target: /run/secrets/outstaff/GH_APP_ID }
secrets:
  sam_GH_APP_ID:
    file: ./secrets/sam/GH_APP_ID
```

Compose does not change the file's owner or mode, so on the host make the files readable by uid 10001: `chown 10001 file && chmod 0400 file` as root, or `chmod 0444` on a host only you use. The files are real files on the Docker host, so keep the folder out of git and out of backups that others read. Better: let the files be created at deploy time from a store (the next sections), on a `tmpfs` or in a directory that is wiped afterwards, and point `SECRETS_DIR` at it.

## 1Password

Keep each secret as a field of an item (for example one item per person), and write the files with the `op` CLI.

```sh
# secrets.map: <file under secrets/> = <1Password secret reference> (acme example keys)
priya/GH_APP_ID=op://Acme Agents/priya github app/app id
priya/GH_APP_PRIVATE_KEY=op://Acme Agents/priya github app/private key
priya/SLACK_BOT_TOKEN=op://Acme Agents/priya slack/bot token
office/ITSAPLAN_API_KEY=op://Acme Agents/office tracker/api key
```

```sh
umask 077
while IFS='=' read -r file ref; do
  [ -n "$file" ] || continue
  mkdir -p "secrets/$(dirname "$file")"
  op read --no-newline "$ref" > "secrets/$file"
done < secrets.map
```

`secrets.map` holds references, not values, so it can be committed. `op read` returns the field's text; for a PEM key stored as a file attachment use the attachment's reference, which `op read` also returns. Where you can, use a template and `op inject -i template -o file` to fill one file from several references.

- **On your machine:** sign in with `op signin`, run the loop, then `docker compose up -d` or the `kubectl` commands.
- **On a server or in CI:** use a [service account](https://developer.1password.com/docs/service-accounts/) (`OP_SERVICE_ACCOUNT_TOKEN`) or a [Connect server](https://developer.1password.com/docs/connect/) and the same `op read` loop. Give the account read access to the one vault only.
- **In Kubernetes:** the 1Password Kubernetes Operator turns an item into a Secret (`OnePasswordItem`), and the External Secrets Operator has a 1Password provider. Each field becomes a key, so name the fields like the files: `OUTSTAFF_AGENT_TOKEN`, `GH_APP_ID` and so on.

Tighten the 1Password side too: one vault for the agents, and read access for the people and machines that deploy, nothing else.

## SOPS

[SOPS](https://getsops.io) encrypts the values in a file and leaves the keys readable, so the encrypted file can live in git next to the deployment. Use [age](https://age-encryption.org) keys, or your cloud's KMS.

```sh
# once: a key for the deployers (keep keys.txt out of git)
age-keygen -o keys.txt            # prints the public key (age1...)
cat > .sops.yaml <<'YAML'
creation_rules:
  - path_regex: secrets-enc/.*\.yaml$
    age: age1yourpublickey...
YAML
```

One encrypted file per person and one for the office, with the file names as keys:

```yaml
# secrets-enc/sam.yaml, created with: sops secrets-enc/sam.yaml
OUTSTAFF_AGENT_TOKEN: ENC[AES256_GCM,data:...]
GH_APP_ID: ENC[AES256_GCM,data:...]
GH_APP_PRIVATE_KEY: ENC[AES256_GCM,data:...]
```

Write the files at deploy time, on the machine that holds the private key (`SOPS_AGE_KEY_FILE=keys.txt`):

```sh
umask 077
for enc in secrets-enc/*.yaml; do
  name="$(basename "$enc" .yaml)"        # sam, office, ...
  mkdir -p "secrets/$name"
  for key in $(sops decrypt "$enc" --output-type json | node -e \
      'console.log(Object.keys(JSON.parse(require("fs").readFileSync(0,"utf8"))).join(" "))'); do
    sops decrypt --extract "[\"$key\"]" "$enc" > "secrets/$name/$key"
  done
done
```

(`--extract` of a string prints it as it is, without a trailing newline or quotes. Check one file on first use.)

In Kubernetes you can also keep complete Secret manifests encrypted (`sops encrypt --encrypted-regex '^(data|stringData)$' secret.yaml`) and apply them with `sops decrypt secret.yaml | kubectl apply -f -`, or let Flux or Argo CD with KSOPS decrypt them in the cluster. Back up the private key somewhere that is not the repository: without it the secrets are gone, and with it they are open.

## Kubernetes Secrets

Kubernetes mounts every key of a Secret as a file, which is exactly the shape the containers read. The [Kubernetes example](/guides/kubernetes/) generates its Secrets with a kustomize `secretGenerator` from one file per key under `secrets/<scope>/KEY`, which is the layout above. The key names are the file names.

Hold the line on three things:

- encryption at rest for Secrets in your cluster, and RBAC that lets few people `get` them;
- mount as files with `defaultMode: 0440` and `fsGroup: 10001` (the example does), never `secretKeyRef` into `env:` except for the office's store URL;
- one Secret per person, mounted only into that person's pod.

### External Secrets Operator

If the values live in a manager (1Password, a cloud secret manager, Vault), the [External Secrets Operator](https://external-secrets.io) writes the Secret for you and keeps it in sync. One `ExternalSecret` per Secret; the keys of `data` are the file names:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: outstaff-agent-sam
  namespace: outstaff-acme
spec:
  refreshInterval: 1h
  secretStoreRef: { kind: ClusterSecretStore, name: acme-secrets }
  target: { name: outstaff-agent-sam }
  data:
    - { secretKey: OUTSTAFF_AGENT_TOKEN, remoteRef: { key: acme/sam, property: agent-token } }
    - { secretKey: GH_APP_ID, remoteRef: { key: acme/sam, property: github-app-id } }
    - {
        secretKey: GH_APP_PRIVATE_KEY,
        remoteRef: { key: acme/sam, property: github-app-private-key },
      }
```

Remove that Secret's entry from the `secretGenerator` of the example. The StatefulSet then mounts the Secret named `outstaff-agent-sam`, which is the target name, so nothing else changes. A pod reads its files when it starts: after a rotation, restart the pod (`kubectl rollout restart sts/outstaff-agent-sam`).

## Rotating and revoking

- **Agent token:** write a new random value to the agent's file and to the office's `OUTSTAFF_AGENT_TOKEN_<HANDLE>`, then restart both. The old connection is refused.
- **Anything an agent holds** (GitHub App key, Slack token, model key): replace it at the source first, then the file, then restart that agent. Scope each one to what the person needs, because an agent can use its own credentials.
- **If a secret leaked:** revoke it at the provider before you do anything else.

## Check the result

Whatever the method, a container sees the same thing:

```sh
docker compose exec sam ls -l /run/secrets/outstaff        # Compose
kubectl -n outstaff-acme exec sts/outstaff-agent-sam -- ls -l /run/secrets/outstaff
```

You should see one file per key, owned by or readable for uid 10001. If a container exits at start with `Missing secret NAME`, the file `NAME` is missing or empty in that directory.
