# Forking and staying current

**NOT FOR PROFIT** — civic public good. Not a commercial product.

Forking is the intended way to run zk-voting, the way a community runs its own Discourse: a city,
union, cooperative or school copies the Node, runs it on its own host, and keeps taking upstream
releases. Nobody needs our permission, our servers or a paid tier.

## What is yours and what is shared

| Yours (your fork, your host) | Shared by everyone |
| --- | --- |
| The Node: voter pages, back office, CMS, plugins, branding | **ZkVotingRollup**, the one L1 contract that settles civic votes for every jurisdiction |
| Your database, your voter roll, your officers | The rule that L1 decrypts and checks only the final sum |
| Your voting hostname (`VOTE_FQDN`), passkeys, email | The guardian protocol (`npm run guardian:rollup`) |
| Your node account (`ROLLUP_PRIVATE_KEY`), your jurisdiction id on the rollup | |
| Polls, which run on your Node only | |

On a public chain you do **not** deploy your own rollup contract. You get a jurisdiction on the
shared deployment and point `ROLLUP_ADDRESS` at it. On a laptop or a test host the `local-l1`
profile deploys a private copy on a local chain, so a fork works with no outside service at all.

## Keep changes where upstream does not touch them

A fork that edits core files gets merge conflicts on every release. Put your changes here instead:

| Change | Where |
| --- | --- |
| Name, tagline, logo, office subtitle | `BRAND_NAME`, `BRAND_SHORT_NAME`, `BRAND_TAGLINE`, `CLIENT_*` in `.env`, or Site admin > Appearance > Branding |
| Colours, radius, spacing | The CSS custom properties in `:root` of `apps/node/public/styles.css` (light and dark). Override them in a stylesheet you add, not by editing rules. |
| Home page and public text | The CMS at `/office/site` |
| Page layout | `LAYOUT_FILE` / `LAYOUT_OVERRIDE_MODULE`; `nav.placement` is `top` (default) or `sidebar` |
| New behaviour | A plugin (`plugins/`, managed from Site admin; see `plugins/announcement-banner` for a small example) |
| Languages | `apps/node/public/locales/*.js` (every locale must carry the same keys; `test/i18n.test.mjs` checks) |

If you must change core code, send it upstream as a pull request so the next release carries it.

## Taking an upstream release

```bash
git remote add upstream https://github.com/<upstream-org>/zk-voting.git   # once
git fetch upstream
git merge upstream/master
cd voting_node && docker compose up -d --build
```

Back up first ([Backups](./backups.md)). The Node migrates its data on boot and keeps older data
loadable, so there is no manual migration step. See [Upgrading](./upgrading.md) and
[Rollback](./rollback.md).

## Rules that come with the code

- **AGPL-3.0-or-later.** If you run a modified Node as a network service, offer its source.
- **Not for profit.** Do not sell it, wrap it in a token, or charge voters. Running it at cost
  (hosting, gas) is the point.
- **Honest defaults stay on.** Mock proofs and Anvil test keys are refused off chain 31337. Do not
  patch that out: until the batch validity circuit exists, a public-chain civic vote cannot be
  settled honestly (see "Known limits" in the root README).
