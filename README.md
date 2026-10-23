# Outstaff

Hire a team of AI agents the way you would staff a project with an agency: a project manager, product, architect, designer, developers, reviewer and devops. Each one has a name, a role and their own accounts. They work in your tracker, chat with you in your messenger, and open pull requests in your repositories.

Outstaff is the agency:

- **A catalog of roles and skills**, shipped as ready-to-run container images. Use it as is, or eject and customize it.
- **A team config** (`outstaff/team.yaml`) in your repository: who is on the team, which repos they can read or write, and which tools you use.
- **An office**: one container that watches your repos and tracker, schedules work for each agent, routes questions between agents, and keeps every ticket and pull request moving.
- **Adapters** for your tools: issue trackers, docs, chat, code hosting and the LLM runtime.

You run the containers wherever you like (Docker Compose, Kubernetes, anything that runs containers), with secrets from wherever you keep them.

> Status: early development. Nothing is released yet. Follow the [milestones](https://github.com/outstaff-ai/outstaff/milestones) for progress.

## License

[MIT](LICENSE)
