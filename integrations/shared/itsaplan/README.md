# @outstaff/integration.shared.itsaplan

What the two Its a Plan adapters share: the tracker ([`@outstaff/integration.tracker.itsaplan`](../../tracker/itsaplan/README.md)) and knowledge ([`@outstaff/integration.knowledge.itsaplan`](../../knowledge/itsaplan/README.md)) adapters each depend on this package and never on each other. It holds the typed REST client and its rate-limit pacer, the connection options and their fallback from the tracker integration to the knowledge one, link templates and the workspace lookup, event cursors, the API's types, the setup guide, the doctor checks and the `ITSAPLAN_*` secrets. Team files never name it; it is installed with either adapter.

## Identity: agents are members

Every agent is a normal member of the instance with its own API key, not an "AI agent" object, so people assign work to it in the UI like to anyone else. A container holds one secret:

| Key                | Scope          | Meaning                                                                      |
| ------------------ | -------------- | ---------------------------------------------------------------------------- |
| `ITSAPLAN_API_KEY` | person, office | API key of that container's member (Account settings > API keys, shown once) |

A key carries its owner's permissions. The office uses a member key of its own.

`Member.kind` is `agent` when the username (or name) is a handle in `team.people`, is listed in `agents`, or the instance flags the member as an AI agent; everyone else is `human`.

## Self-hosted instances and custom CAs

With `ca_file` the adapter makes its requests through an `undici` agent that trusts that PEM file in addition to the system roots. Without it the injected `fetch` is used as is, so you can also run the process with `NODE_EXTRA_CA_CERTS=/etc/acme/ca.pem`.

## Rate limit

The service limits each API key by burst, not per minute: about 100 requests are allowed while each comes within roughly a second of the previous one, and the next one answers HTTP 500 (not 429) until the key has been idle for about a second. The shared HTTP client therefore:

- paces every request per API key and host (the tracker and knowledge adapters of a process share one pacer): after 80 requests in a burst, the next waits until the key has been idle for 1.1 s, then a new burst starts;
- retries a `GET` (and `HEAD`, `PUT`, `DELETE`) once, after 1.2 s, when it gets a 500 in the middle of a burst, and logs it at warn as `rate limited`; a 500 on the first request after an idle period is a real failure and is not retried;
- never retries `POST` or `PATCH`, because it cannot tell whether the first attempt took effect; their 500 surfaces as `unavailable`.

Pacing is per process: several containers using the same key still share the service's budget, which is what the single retry covers.

## Errors

401 and 403 `forbidden`; 404 `not_found`; 409 `conflict` (stale document version, WIP limit); 429 `rate_limited` with `retryAfterMs` from `retry-after`; 400 and 422 `invalid`; 5xx and network failures `unavailable` (see Rate limit for the one 500 that is retried). The platform's `code` and message are kept in the error message.

## Tests

`pnpm test` covers the client, the custom CA path, the pacer, setup and doctor against stubbed responses; the adapters' tests drive it end to end over the Its a Plan stand-in (`@outstaff/testing.itsaplan`), whose shapes derive from this package's API types.
