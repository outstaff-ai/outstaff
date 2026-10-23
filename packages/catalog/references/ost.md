# The `ost` verbs

`ost` is how you reach the team's systems. It is the same whatever tracker, document store or code host the team uses. Outputs include links; pass them on.

| Verb         | Use it to                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `ost ticket` | Read, create, comment on, assign and move tickets. Statuses are the canonical ones in `process/ticket-lifecycle.md`. |
| `ost doc`    | Read and write documents in the team's knowledge store.                                                              |
| `ost pr`     | Open and update pull requests; read review threads, reply to them and resolve them.                                  |
| `ost ask`    | Ask another person, by handle or role. See `references/team.md`.                                                     |
| `ost work`   | See your current work item and your queue.                                                                           |
| `ost team`   | List the live roster: people, roles, trusted humans and who is busy.                                                 |
| `ost me`     | Show who you are: your handle, role and team.                                                                        |

Run any verb with `--help` for its options.

## Habits

- Check `ost work` before taking on anything new.
- Put the links `ost` returns in your comments and messages. Never write a bare id.
- A verb that fails is information: read the error, fix the input, retry once. If it still fails, say so in the hand-back.
{{#unless integrations.has.tracker}}
- This team has no tracker: `ost ticket` is not available. Work items are the record.
{{/unless}}
