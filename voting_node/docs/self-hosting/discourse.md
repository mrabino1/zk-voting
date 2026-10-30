# Community forum (optional Discourse)

**NOT FOR PROFIT** — civic public good. Not a commercial product.

zk-voting counts votes. It does not host debate. People decide better when they can talk first, so we encourage every operator to run an open-source [Discourse](https://www.discourse.org) forum ([source](https://github.com/discourse/discourse), GPL-2.0) next to their Node, where constituents can discuss polls and elections with each other.

This is **optional**. zk-voting works the same with or without a forum, and nothing in the app depends on it.

## Why run a forum

- **Deliberation before a vote.** Voters can read the question, ask what it means, and hear arguments from neighbors before the poll opens.
- **Reflection once a result may be shown.** Turnout is public hourly from the first ballot, for a poll and for a vote. Per-choice counts publish with the posted tally; hourly per-choice blocks after the gate are planned. A poll's per-choice counts wait until 100 first ballots are in or the scheduled end. A vote publishes choices only in the final tally. The forum shows *why*, and where the next question should come from.
- **Transparency.** Organizers can publish the ballot text, timeline, eligibility rules, and disqualification reason codes in one public, linkable place.
- **Q&A with candidates and organizers.** A per-election category gives candidates, election officers, and the independent auditor a place to answer questions in public.
- **Open source end to end.** Discourse is self-hosted and free, in the same spirit as zk-voting: no vendor owns the conversation.

## Polls and votes

The person who creates a contest chooses the kind. Say which kind it is in the category title or the pinned post, and follow that kind when anyone talks about numbers.

**Poll.** Use a poll when the group wants an open picture while people are still responding: a temperature check, a non-binding question, a club show of hands. Turnout is public hourly from the first ballot. Each hour publishes 30 minutes after it closes (`DISCLOSURE_DELAY_SECONDS`, default 1800): ballots from 08:00–08:59 appear at 09:30. An hour with fewer than 10 ballots (`DISCLOSURE_MIN_BLOCK_VOTES`) merges forward into a later block. When the scheduled end passes, no more ballots are accepted. The total freezes once the last hour clears the 30-minute delay. The published hourly blocks show the running turnout. Per-choice counts publish with the posted tally; hourly per-choice blocks after the gate are planned. A poll's per-choice counts wait until 100 first ballots are in or the scheduled end, whichever comes first (`RESULTS_MIN_VOTES`). The final tally at close is final. A voter can change their vote until the deadline, and only the last vote counts. At the deadline, one final batch goes to L1 for both polls and votes. Discuss published turnout once the hour is out, and per-choice counts only after they are posted. Never ask anyone when they voted or which block their ballot is in. Discussing it never links a forum account to a ballot.

**Vote (an election).** Use a vote when the choices must stay hidden until the deadline: leadership, a binding decision, or any contest where an early count of choices could change who still turns out or how they vote. Turnout is visible during the election, published in the same hourly blocks and on the same schedule as a poll. The choices stay sealed. They are encrypted to a public key posted on the L2. The decryption key is generated jointly by k-of-n guardians, so no single private key ever exists and no single party, including the operator, can decrypt early. The choices are decrypted and published only at the deadline. A voter can change their vote until the deadline. Only the last vote counts. The zero-knowledge proof and the nullifier enforce one counted vote per voter. At the deadline, one final batch goes to L1 for both polls and votes. The forum may discuss published turnout. Do not post choice counts before the deadline, in an announcement, a pinned topic, or a reply. There is no early decryption to copy onto the forum. After the deadline, announcements may link to the published choices and the auditor report. Discussing it never links a forum account to a ballot.

## How to run it

Run Discourse as its **own service on its own subdomain**, for example `community.<your-domain>` next to `vote.<your-domain>`. Do not put it on the same hostname as the Node: passkeys are bound to the voting hostname, and keeping the two apart keeps cookies and sessions apart too.

| Option | Notes |
| --- | --- |
| **Official Docker install** (recommended) | Discourse's supported path is [`discourse_docker`](https://github.com/discourse/discourse_docker): clone it to `/var/discourse` on a Linux host and run `./discourse-setup`. It asks for the hostname, admin email, and SMTP settings, then issues a Let's Encrypt certificate. Give it its own small VM (2 GB RAM or more) so its built-in web server owns ports 80/443. Updates come from the forum's own `/admin/upgrade` page or `./launcher rebuild app`. |
| **Coolify** | Check Coolify's one-click service catalog for a Discourse template, or point Coolify's proxy at a Discourse host you installed with the official script. Same rules as the [Coolify](./coolify.md) guide: HTTPS only, its own domain. |
| **Dokploy, CapRover, plain Linux** | Any open-source host that runs Docker works. If the forum shares a machine with the Node, put both behind one reverse proxy (Caddy, Traefik, nginx) with separate hostnames. See [Dokploy, CapRover, plain Compose](./other-platforms.md). |

Whatever you choose:

- **HTTPS only.** Turn on "force https" in Discourse and never serve it over plain HTTP.
- **Working email.** Discourse needs outbound SMTP for sign-up and notifications. You can reuse the same provider you configured for the Node (for example AWS SES); see the [Configuration reference](./configuration.md).
- **Backups.** Discourse makes its own backups from `/admin/backups`. Store them alongside the Node's [Backups](./backups.md), but they are separate archives.
- **Link both ways.** Add a "Community" link to your public site text at `/office/site`, and link back to the voting site from the forum's header.

### Single sign-on (future, not implemented)

Discourse supports [DiscourseConnect](https://meta.discourse.org/t/setup-discourseconnect-official-single-sign-on-for-discourse-sso/13045), which lets an existing site act as the login provider. zk-voting **does not implement a DiscourseConnect provider today**. It may be added later as an optional feature. Until then, forum accounts are created on the forum itself, and that separation is a privacy feature, not a gap (see below).

## Suggested categories

| Category | Use |
| --- | --- |
| **Announcements** | Read-only for organizers. New polls and elections, and opening and closing times. Link turnout once the hourly snapshot is published, from the first ballot. For a poll, link per-choice counts only after the posted tally; those counts wait until 100 first ballots are in or the scheduled end. For a vote, link the choices and the auditor report only after the deadline. |
| **One category per election or poll** | For example `2027 Budget Poll` or `2027 Board Election`. Name the kind in the title. Pin the ballot text, timeline, and eligibility rules. Use it for questions, arguments, and candidate Q&A. For a vote, do not pin or discuss choice counts before the deadline. Turnout may be discussed once it is published. Close the category (read-only) after the choices are published. |
| **Feedback** | Bugs, accessibility problems, and ideas for the voting site itself. |
| **Meta / How this forum works** | Rules, moderation policy, and who the moderators are. |

## Moderation and privacy rules

Post these rules in the forum and enforce them.

- **Nobody has to say how they voted.** Sharing your own choice is allowed, but it is never required, never rewarded, and never asked for by organizers, employers, candidates, or moderators.
- **Do not leak a vote's sealed choices.** For a vote, choice counts stay sealed until the deadline. Do not post them, and do not ask for an early decryption. No single party, including the operator, can decrypt them early. Turnout may be discussed once the hourly snapshot is published, from the first ballot, on the same schedule for a poll and for a vote. A poll's per-choice counts wait until 100 first ballots are in or the scheduled end, and they publish with the posted tally. Those posted counts may be discussed once they are on the dashboard.
- **The forum identity is separate from the ballot.** zk-voting keeps ballots anonymous with zero-knowledge proofs. A forum account must **never** be linked to a ballot, a nullifier, a receipt, or a voting credential, by the operator or by anyone else. Do not build plugins, exports, or analytics that join forum data with voting data. Do not ask people to post receipts or screenshots of their ballot.
- **No vote buying and no coercion.** Remove offers to pay for votes, threats, and demands for proof of how someone voted. Remove posts asking whether someone re-voted or changed their vote, since that is a coercion vector. Ban repeat offenders and report crimes to the relevant authority.
- **Keep personal data out.** Do not post voter-roll entries, addresses, or identity documents. Disqualification appeals go through the app's due-process flow, not public threads.
- **Moderators are not officers.** Forum moderation powers give no power in the voting system, and the reverse. Use different accounts for each role.
- **Publish your moderation log policy.** Say what gets removed and why, so moderation itself is transparent.

## Related pages

- [Self-hosting overview](./README.md)
- [Requirements](./requirements.md)
- [Tailscale sidecar](./tailscale.md) — if the forum should stay private to a tailnet
