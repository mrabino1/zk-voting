---
version: 1
lastUpdated: 2026-09-19
title: Republic Terms of Use
filename: republic-terms.pdf
---

# Republic Terms of Use

**NOT FOR PROFIT** — civic public good. Not a commercial product. No token. No fees to voters.

Last updated: 19 September 2026. Version 1.

These Terms of Use (“Terms”) govern access to and use of Republic (repository name zk-voting), including this Node, its public pages, registration, voting, officer desks, and related APIs (the “Service”). The English text controls.

The SHA-256 fingerprint the Node records is of the **exact PDF bytes** generated from this markdown source (UTF-8). The Node also publishes a SHA-256 of this markdown file so an operator can see both fingerprints. Changing this source changes both hashes.

## 1. Acceptance of Terms

By accessing the Service, creating an account, checking “I agree,” or otherwise using Republic, you acknowledge that you have read these Terms and agree to be bound by them.

If you act for a jurisdiction, union, cooperative, or other body, you represent that you have authority to bind that body to the operational rules of the Node it hosts.

Registration on this Node requires an affirmative acceptance. The Node stores who accepted, when, which PDF SHA-256, and whether a PDF copy was emailed.

## 2. Nature and purpose — civic public good

Republic exists so a city, county, state, nation, union, cooperative, professional college, or (if a jurisdiction demanded it) a shareholder meeting can run a roll, a ballot, and a publicly checkable result with private choices.

The Service is **not for profit**. There is no paid SaaS tier in this software, no token, and no vendor lock-in. Hosting may be run **at cost** by a government or volunteer. Nobody is to make money off this repository. See `/NOT_FOR_PROFIT.md`.

Republic is software. Running it does not, by itself, satisfy a given elections statute or guarantee that a court must accept a particular deploy.

## 3. Who provides the Service

The Service on a given host is provided by the operator of that Node (a clerk, IT shop, or volunteer), not by a commercial product company. Contract addresses, if any, are the shared civic deployment the operator pins. Fork the Node UI; do not deploy a new factory for each city.

## 4. Not legal advice, not a certification, not a broker

Republic is not a law firm, not your agent, not a broker, not an escrow of funds, and not a substitute for professional legal, tax, or election-administration advice. Documents, rolls, and tallies in the Service are produced by users and officers of the hosting jurisdiction.

This development line (`test/unstable`) is a working demo. Local tests still use a MockVerifier. Poseidon is not wired. There is no production Groth16 ceremony. Do not treat a local demo accept as court-ready.

## 5. No fees to voters

Voters do not pay gas. The paymaster / relayer, when configured, sponsors L2 fees from the jurisdiction budget at cost. The Node must not charge voters to register, to vote, or to read results.

## 6. Accounts, identity, and eligibility

A person is unique. You may verify email, a Web3 wallet, a smart-card reader, a driver’s license or passport, and a passkey. Several Ethereum addresses may be verified internally; only one is active. The public roll stores an identity commitment, never your name, never a document number, and never the active address as the Merkle leaf.

Email is the username and the second factor. After another first factor, Republic sends a 6-digit code through AWS SES when configured.

Registered is not the same as eligible. A clerk or disqualification officer may bar a registered person for a public reason code. Personal evidence stays off-chain; only a hash of evidence is posted.

You must be old enough, under the hosting jurisdiction’s law, to participate in the elections you join. The Service is not directed at children as a social product.

## 7. Ballots, receipts, and coercion

Each nullifier is accepted once. Double voting is impossible on that rule. You may change your mind on the form before submit; after accept you cannot recast.

Receipts list hashes only (ballot hash, nullifier, related identifiers). They cannot prove “I voted for X.” Public dashboards delay vote proofs until the UTC hour that contained the vote has closed, so walking out of a polling place cannot be matched to a live tick.

Choice is never printed on a receipt, explorer row, or officer live feed.

## 8. Privacy, cookies, and data the Node stores

The Node JSON store (`republic.json`) may hold handles, hashed authenticators, session ids, election records, and terms-acceptance fingerprints. It must not hold legal names, dates of birth, or street addresses on chain. License and passport numbers are hashed, not stored.

Session cookies (`republic.sid`, `republic.mfa`) are first-party, HttpOnly, and needed to keep you signed in and to complete email MFA. Blocking them prevents sign-in.

Transactional email (MFA codes and, on acceptance, a PDF of these Terms) is sent with AWS SES when `SES_FROM_ADDRESS` and `AWS_REGION` are set. Do not reply to those messages; the From address may be unmonitored.

Independent auditors use public artifacts, not the private Node data file.

## 9. Electronic records and this PDF

You agree that the Node may provide these Terms and related notices electronically, including by emailing a PDF attachment of the current Terms when you accept them. The PDF is generated from this markdown. The recorded fingerprint is SHA-256 of the exact PDF bytes. A SHA-256 of the markdown source is published alongside it.

Viewing `/terms` shows the current fingerprints. Acceptance (checkbox at register, or the accept control while signed in) writes a record: person or email, timestamp, version, PDF SHA-256, markdown SHA-256, and whether the PDF was emailed.

## 10. Intellectual property and license

Source code is licensed AGPL-3.0-or-later unless a file says otherwise. These Terms are part of the civic public-good documentation. You may run, study, and share the software under that license. You may not wrap it in a token, sell it as SaaS, or skim voter or jurisdiction funds.

Marks such as “Republic” as used here name this civic project. They are not a claim of government endorsement.

## 11. Availability and limitations

The Node is allowed to be down. Chain records (L2, and L1 if you mirrored a tally) must still be enough for an independent verifier when those layers are configured. Demo mode without `CHAIN_RPC` writes only local JSON.

Officers freeze rolls, post tallies, and certify hashes according to the roles the Node enforces. The software does not invent who is eligible.

## 12. Disclaimers

THE SERVICE IS PROVIDED “AS IS” AND “AS AVAILABLE,” WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT, TO THE MAXIMUM EXTENT PERMITTED BY LAW.

No warranty is made that a given deploy is free of defects, that proofs will verify on a ceremony that does not yet exist, or that a court must treat a demo tally as binding.

## 13. Limitation of liability

To the maximum extent permitted by law, the authors, operators, and contributors are not liable for indirect, incidental, special, consequential, or punitive damages, or for lost votes, lost elections, lost profits, or data loss, arising from the Service or from reliance on a demo or misconfigured host.

Nothing in these Terms excludes liability that cannot be excluded under applicable law (including liability for death or personal injury caused by negligence, or for fraud).

## 14. Indemnity (operators and organizations)

If you host a Node or invite others onto a roll, you will defend and indemnify the volunteer authors of this repository against claims arising from your operation, your roll, your officer actions, or your failure to follow the not-for-profit rules — except to the extent caused by the authors’ fraud.

## 15. Suspension and termination

The operator may suspend an account that abuses the Service, attempts to deanonymize ballots, or commercializes the software. Disqualification of a voter is a coded officer action, not a silent delete. After roll freeze, new marks follow the election’s `lateUpdateAllowed` rule (default false).

You may stop using the Service at any time. Chain records already published are not erased by deleting a Node session.

## 16. Changes to Terms

We may update these Terms. The “Last updated” date and version above will change when we do. A material change produces a new PDF and a new SHA-256. Prior acceptances remain on file with the hash that was current when you accepted. The Node may ask you to accept the new hash.

## 17. Governing law

These Terms are interpreted under the law of the jurisdiction that hosts the Node, excluding conflict-of-law rules that would choose another forum. If you are a government operator, mandatory public-contract and elections law of that government controls to the extent it conflicts with this section.

This is not a forced consumer arbitration clause and not a class-action waiver. Civic disputes belong in the forums that already judge elections.

## 18. General

If a provision is unenforceable, the rest remains. These Terms plus the AGPL license and `/NOT_FOR_PROFIT.md` are the agreement for using this Node. A waiver on one occasion is not a waiver later. Headings are for reading, not for limiting a section.

## 19. Contact

Questions about a live election belong to the hosting clerk, not to unmonitored SES mail. Questions about the software belong in the public repository for zk-voting.

Do not send trapdoors, seed phrases, document numbers, or ballot choices to email.

NOT FOR PROFIT — civic public good. Not a commercial product.
