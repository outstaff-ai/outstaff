---
title: Tell your agents how your repo works
description: Put your commit, branch and pull request rules in the repository itself, and tell Outstaff when a file cannot change.
---

Outstaff does not decide how work is done in your repository. How many commits a pull request has, what a commit message looks like, how a branch is named, what the pull request description contains and which tests to run are your repository's rules, and your agents follow them like any contributor would.

## What agents read

Before an agent changes code, its work prompt lists the convention files it found in the worktree, and it reads them first:

- `CONTRIBUTING.md`, `AGENTS.md`, `.github/CONTRIBUTING.md` and `docs/CONTRIBUTING.md`;
- the pull request template, `.github/pull_request_template.md`, which the agent uses for the description instead of the catalog's template;
- the rules your CI enforces, such as a commit message linter or a single-commit check, which the agent sees when a check fails.

The agent follows what these say for commits (count, format, signing), branch names, the pull request title and body, the tests to run and anything else they state. Rules that need writing down for people also work for agents, so a good `CONTRIBUTING.md` helps both.

## An example

This section of a `CONTRIBUTING.md` is enough:

```markdown
## Commits and pull requests

- One commit per pull request. Address review by amending it, then push with `git push --force-with-lease`.
- Commit messages and pull request titles look like `ACME-123: short summary`.
- Name branches `acme-123-short-name`.
- Fill in the pull request template. Say why the change is needed before what it does.
- Run `pnpm lint` and the tests of the packages you changed. CI runs the rest.
```

A team that prefers several commits and squash merges says that instead:

```markdown
## Commits and pull requests

- Keep commits focused, with a clear message each. Address review with new commits; do not rewrite pushed history.
- We squash merge. The pull request title becomes the commit message, so write it as `type: summary`.
```

## When the repository says nothing

The catalog only states defaults for what your repository leaves open, and says so: focused commits with clear messages, in the style of the recent history; a pull request description that says why; and never rewriting a commit that is not the agent's own or touching anyone else's branch. Where your rules and a default disagree, your rules win.

A few mechanics belong to Outstaff and stay whatever your rules say: agents never push to the default branch, only push to their own branch or the head branch of the pull request they work on, and push with `--force-with-lease` after rewriting commits that are already pushed.

## When the files cannot change

Some repositories belong to someone else, or cannot take a `CONTRIBUTING.md` yet. State the rules in `team.yaml` instead:

```yaml
repos:
  - name: shop
    url: github.acme.example/acme/shop
    kind: primary
    conventions: |
      One commit per pull request; amend it when review asks for changes.
      Titles start with the ticket key, for example "ACME-123: add a greeting".
```

`conventions` is free text. It is part of the agent's instructions for that repository, in addition to the files in it.

## CLAUDE.md is not a convention file

A repository's `CLAUDE.md` is often written for a person's own assistant sessions: a persona, a personal workflow, shortcuts. Loaded into an agent session it can conflict with the agent's role. So Outstaff does not load a project `CLAUDE.md` into agent sessions, and does not list it as a convention file. Put what every contributor must follow in `CONTRIBUTING.md` or `AGENTS.md`.

If a repository's `CLAUDE.md` really is the right place for its rules, list it:

```yaml
repos:
  - name: shop
    url: github.acme.example/acme/shop
    kind: primary
    instructions: [CLAUDE.md]
```

The work prompt then names the file, and the agent reads it with the others. `instructions` takes paths inside the repository, up to ten.
