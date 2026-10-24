# Security Policy

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue, pull request or discussion for them.

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability** and fill in the advisory form.

Your report stays private between you and the maintainers until a fix is ready. We will acknowledge it, work on a fix together with you, and credit you in the advisory if you want us to.

## Supported versions

Outstaff has not released a version yet. Only the `main` branch receives security fixes. Once the first release ships, this section will list the supported versions.

## Scope and trust model

Outstaff runs AI agents that act with the credentials you give them: tracker tokens, repository access, chat and runtime keys. Anything an agent is allowed to do with those credentials is within the trust you have granted it. Reports about an agent doing what its configured grants allow are configuration questions, not vulnerabilities, but we are glad to hear about them.

Please include in a report:

- the affected package or container and the version or commit you tested,
- steps to reproduce, and what an attacker gains,
- whether the issue needs a particular team configuration (`.outstaff/team.yaml`) or grants.

## The Claude credential and the agent's commands

By default (`sandbox: off` in the runtime options), commands an agent runs can read the Claude credential from their environment, the same as Claude Code on a developer's machine. Other adapters' secrets are removed from that environment. To limit the risk: only trusted humans direct work; deny network tools in the team's command policies if you want; give each team a dedicated API key with a spend limit; rotate it if it leaks. `sandbox: bubblewrap` keeps the credential out of the commands' reach where the containers allow user namespaces; see the [runtime adapter](packages/runtime-agent-sdk/README.md#sandbox) and decision 0013. With `bubblewrap` on, a way for a command to read the credential is a vulnerability; with `off`, it is the documented trade-off.

The trust model (which humans and agents can trigger work, how grants are checked, and what the office stores) will be documented alongside the docs site. Until then, treat the office and agent containers as holding every secret they are given.
