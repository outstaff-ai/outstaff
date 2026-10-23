---
title: Configure outstaff with an assistant
description: A guide for an AI assistant that is setting outstaff up for a user, with the questions to ask and the order of steps.
---

This page is written for an AI assistant that a user has asked to set up outstaff for them. If you are that assistant, follow it in order. Do not guess answers: ask the user, and write down what they say.

Outstaff is still in early development. Where a command does not exist yet, this page marks the step as **planned** with the milestone that will deliver it. Do not invent commands or flags for planned steps. Do the step by hand or tell the user it is not available yet.

## What you are setting up

A team is described by `.outstaff/team.yaml` in the user's own repository: the humans, the people (agents), the repositories with read and write grants, the integrations, the workflow and the policies. One office container runs the team, and one agent container runs per person. See the [architecture overview](/architecture/overview/) and the [concepts](/concepts/).

## Questions to ask the user

Ask these before changing anything.

1. **Tracker.** Which issue tracker do they use? A tracker is optional, so "none" is a valid answer.
2. **Knowledge base.** Where do they keep documents and notes, if anywhere? Also optional.
3. **Chat.** Which chat workspace should the team live in?
4. **Code host.** Where are their repositories?
5. **LLM runtime.** Which runtime should the agents use, and with which credentials? The Claude Agent SDK is the primary runtime, with the Claude Code CLI as a fallback ([decision 0009](/decisions/0009-agent-sdk-runtime/)). The user supplies their own API key, cloud-provider credentials or subscription token; never ask for or store them yourself.
6. **Container hosting.** Where will they run containers (Docker Compose on one machine, Kubernetes, a managed container service, something else)? This is their choice. Outstaff does not pick it for them ([decision 0008](/decisions/0008-hosting-and-secrets-out-of-scope/)).
7. **Secrets.** How do they keep secrets (env files, a password manager, encrypted files in git, a cloud secret manager)? Also their choice. Containers read secrets from environment variables or from files under `/run/secrets/outstaff/<KEY>`, whoever puts them there.
8. **Repositories.** Which repositories will the team work in? For each one, which people may only read it and which may write to it?
9. **Team size and roles.** How many people (agents) do they want, and in which roles? The catalog covers a project manager, product, architect, designer, developers, a reviewer and devops. What names should the people have?
10. **Trusted humans.** Who may direct the team? By default this is anyone with write access to a repository and every full member of the chat workspace (not guests, not bots). For a large workspace or an open-source repository, ask for an explicit list of named humans and their identity on each system ([decision 0004](/decisions/0004-trust-model/)). There is no owner role.

Confirm the answers back to the user in one summary before you continue.

## Order of steps

1. **Create the team config.** Create `.outstaff/team.yaml` in the user's repository from their answers: humans, people, repos with grants, integrations. The `ost init` command is **planned** (milestone M1 Config). The schema reference will be in the [reference section](/reference/) (also M1 Config). Until then, tell the user the config format is not published yet.
2. **Validate the config.** `ost validate` is **planned** (milestone M1 Config).
3. **Set up each person.** For every person, they need their own accounts on the code host, the chat workspace and, if used, the tracker. `ost hire <role>` adds a person and walks through their setup, and `ost setup` writes credential templates (`.env.example` files, one note per key saying where the value comes from) and prints exact steps and manifests for creating apps. Both are **planned** (milestone M6 Onboarding). Creating apps on chat, code-host and tracker platforms stays manual, and the user must do it or approve it. Never create accounts or apps on the user's behalf without their say-so.
4. **Check the setup.** `ost doctor` is **planned** (milestone M6 Onboarding).
5. **Deploy.** Help the user run one office container and one container per person where they chose to host. The deployment and secrets guides are **planned** (milestone M7 Release 0.1) and will be linked from the [guides](/guides/). They will be written so you can follow them. Until they exist, rely on the container contract from [decision 0008](/decisions/0008-hosting-and-secrets-out-of-scope/).

## Rules for the assistant

- Hosting and secret storage are the user's choice. Offer options, then follow what they pick.
- Never ask the user to paste secrets into chat. Put them where their secrets setup says, using the generated templates.
- Do not invent commands, flags or config keys. If something is not documented here or in the [reference](/reference/), say so.
- Use only information the user gave you. Do not copy names, URLs or credentials from other projects into their config.
