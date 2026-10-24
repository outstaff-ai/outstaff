# Secret files

`kustomization.yaml` generates every Secret from the files in this tree, one file per key: `secrets/<scope>/<KEY>`. Everything here except this README is ignored by git, so real values cannot be committed by accident. A file holds the bare value and nothing else, so a multi-line value such as a PEM private key stays intact. A trailing newline is trimmed by the container.

These are the files for the acme example team, whose adapters are github, itsaplan, slack and claude-agent-sdk. Each adapter declares its own secrets, so your list depends on your `integrations` and on each person's repository grants. Run `ost setup office` and `ost setup <handle>` to get the exact keys for your team (each `.env.example` says where every value comes from), then edit the `secretGenerator` in `kustomization.yaml` to match. See [Secrets](https://docs.outstaff.work/guides/secrets/) for storing the files with 1Password or SOPS instead of typing them in.

`ost setup` also lists keys that `--derive` fills in for you (`SLACK_BOT_USER_ID`, `ITSAPLAN_MEMBER_ID`) and alternatives such as `*_PRIVATE_KEY_FILE`. The example generates the keys below; add a line to the generator for any other key you use.

## secrets/office/

The team-wide secrets. They go into the `outstaff-office` Secret. The five `GH_OFFICE_APP_*` files are also copied into the Secret of each person who has repository grants.

| File                            | What it is                                                      |
| ------------------------------- | --------------------------------------------------------------- |
| `GH_OFFICE_APP_ID`              | Id of the team's read-only office GitHub App                    |
| `GH_OFFICE_APP_INSTALLATION_ID` | Its installation id on the team's account                       |
| `GH_OFFICE_APP_PRIVATE_KEY`     | Its private key (PEM text)                                      |
| `GH_OFFICE_APP_SLUG`            | Its URL slug                                                    |
| `GH_OFFICE_APP_BOT_EMAIL`       | Commit email of its bot (`ost setup office --derive`)           |
| `ITSAPLAN_API_KEY`              | API key of the member account the office acts as in the tracker |
| `SLACK_OFFICE_BOT_TOKEN`        | Bot token of the Slack app the office uses (`xoxb-...`)         |

The office also gets `OUTSTAFF_AGENT_TOKEN_<HANDLE>` for every person. The generator reads it from that person's `OUTSTAFF_AGENT_TOKEN` file, so there is nothing to add here.

## secrets/<handle>/

One folder per person: `priya`, `tomas`, `mira`, `leo`, `sam`, `noor`, `ines`, `kofi`. Each person's Secret `outstaff-agent-<handle>` holds only the files below and is the only secret that pod mounts.

Every person has these:

| File                   | What it is                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `OUTSTAFF_AGENT_TOKEN` | A long random value you choose: `openssl rand -hex 32 > secrets/priya/OUTSTAFF_AGENT_TOKEN` |
| `ANTHROPIC_API_KEY`    | The agent's Anthropic API key (or sign in another way and change the generator)             |
| `SLACK_APP_TOKEN`      | This person's Slack app-level token (`xapp-...`)                                            |
| `SLACK_BOT_TOKEN`      | This person's Slack bot token (`xoxb-...`)                                                  |
| `ITSAPLAN_API_KEY`     | API key of this person's own tracker member account                                         |

The GitHub keys follow the person's repository grants in the team file:

| Person                                          | Grants                   | GitHub files                                                                       |
| ----------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `priya`, `tomas`, `mira`, `sam`, `noor`, `kofi` | at least one write grant | the five `GH_APP_*` files below and the five `GH_OFFICE_APP_*` files of the office |
| `ines`                                          | read grants only         | the five `GH_OFFICE_APP_*` files; her own App is optional and not generated        |
| `leo`                                           | none                     | none: the agent starts without a code host                                         |

| File                     | What it is                                              |
| ------------------------ | ------------------------------------------------------- |
| `GH_APP_ID`              | Id of this person's own GitHub App                      |
| `GH_APP_INSTALLATION_ID` | Its installation id                                     |
| `GH_APP_PRIVATE_KEY`     | Its private key (PEM text)                              |
| `GH_APP_SLUG`            | Its URL slug                                            |
| `GH_APP_BOT_EMAIL`       | Commit email of its bot (`ost setup <handle> --derive`) |

The `GH_OFFICE_APP_*` files are not repeated per person: the generator takes them from `secrets/office/`.
