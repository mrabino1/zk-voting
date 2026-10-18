# Implementation

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`NOT_FOR_PROFIT.md`](./NOT_FOR_PROFIT.md).

## 1. Spirit of the project

It is very similar to discourse.org, where people can chat about various subject matters. The goal is to "abstract not only a conversation that we could have with a forum-style site like Discourse, but also to then allow it to turn into actionable voting components." Zero-knowledge proofs underpin the voting so participation stays private.

The flow is:

1. Open a discussion topic.
2. Turn that topic, or a post in it, into a proposal.
3. The proposal becomes a poll or an election.
4. Eligible people cast a private zero-knowledge vote. The choice stays off the public record.
5. A verifiable result is linked back to the same discussion.

The conversation layer is the work in section 3. The voting stack this flow ends on is already in this repository.

## 2. Architecture principles

The entire framework of the repo is architected around it being "open source and then given away" so that people can put it in their "own Docker setup, exact, similar to the way Discourse is", have it "run on their own subdomain", and "configure it the way that you can do with Discourse."

- **Self-hosted first.** One Docker Compose file, one install command, configuration from the environment and an admin panel, and no dependency on a hosted operator. A jurisdiction runs its own copy.
- **Per-instance settings.** Branding, categories, roles, login methods, and voting settings are configured on that instance from an admin settings UI, in the same way Discourse is configured.
- **Privacy by design.** Voting is zero-knowledge. A ballot does not leak the choice as plaintext. Eligibility and a single spent nullifier can be public; the selection cannot.
- **License and charter.** The license stays AGPL-3.0-or-later (`package.json` sets `"license": "AGPL-3.0-or-later"`). `LICENSE` states: "This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version." The same file's NOT FOR PROFIT charter states: "This project exists to protect and preserve republican democracy. It is not a commercial product, is not to be sold, and is not to be used as the basis of a for-profit voting vendor." [`NOT_FOR_PROFIT.md`](./NOT_FOR_PROFIT.md) states: "There is no token. There is no paid tier. There is no vendor lock-in. Nobody is to make money off this repository."
- **Upgrades in place.** Named data volumes stay mounted across a restart. A rolling update starts the new container beside the old one on the same host and the same volumes, then hands off writes. See [`docs/ROLLING_UPDATES.md`](./docs/ROLLING_UPDATES.md).

## 3. Next Steps (when Cursor credits return)

1. **Forum-style conversation layer.** Categories, topics, replies, user roles, and moderation, reusing existing accounts and sign-in. Accounts and roles already exist in `apps/node` (`apps/node/src/roles.mjs`); sign-in covers email, wallet, smart card, civic ID, and passkey (`apps/node/src/identity.mjs`).
2. **Link conversations to actionable voting.** Turn a topic or a post into a proposal, a poll, or an election. Clerks can already open elections with `POST /api/elections` (`apps/node/src/routes/elections.mjs`); token polls exist behind `POLLS_ENABLED` (`apps/node/src/routes/polls.mjs`).
3. **Layer the existing zero-knowledge voting components on top.** Check eligibility, accept a private zero-knowledge ballot, tally, and post the verifiable result back on the topic. Eligibility, the vote circuit, tally, and election results are already in `circuits/vote.circom`, `circuits/tally.circom`, `smart-contracts/`, and `apps/node/src/routes/elections.mjs` (`GET /api/elections/:id/results`).
4. **Docker packaging for self-hosting.** A single image or Compose file, an install script, guided setup, and in-place upgrades. Root `docker-compose.yml` already builds the Node and the civic L2 and keeps data on `node-data` and `l2-data`; `npm run compose:up` is `docker compose up -d --build`. In-place overlap is [`docs/ROLLING_UPDATES.md`](./docs/ROLLING_UPDATES.md).
5. **Self-hosted subdomain deployment.** DNS and TLS guidance, and notes for the reverse proxy. [`docs/OPERATOR.md`](./docs/OPERATOR.md) already tells the operator to set `VOTE_FQDN`, point a DNS record at the host, terminate TLS, and put Caddy, nginx, or a load balancer in front of the Node.
6. **Discourse-like configuration.** An admin settings panel for site settings, theming and branding, and plugin or extension points. A platform admin can already set the site title, tagline, public pages, and shared contract pins at `/office/site` (`apps/node/src/cms.mjs`, `apps/node/public/cms.js`).
7. **Docs, an operator guide, and a security review before a public release.** The operator guide is [`docs/OPERATOR.md`](./docs/OPERATOR.md). The election threat map is [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md). Independent verification is `tools/auditor` and [`docs/AUDITOR.md`](./docs/AUDITOR.md).
