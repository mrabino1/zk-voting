---
version: 3
lastUpdated: 2026-11-24
title: ZK-Voting Terms of Use
filename: zk-voting-terms.pdf
---

# ZK-Voting Terms of Use

**PLACEHOLDER TEMPLATE — REPLACE BEFORE USE.** These Terms are a starting point that ships with the software. They are not legal advice and have not been reviewed for any jurisdiction. Every operator must replace each bracketed field (for example [OPERATOR LEGAL NAME]), delete what does not apply, and have the result reviewed by counsel admitted where the Node is hosted before real voters accept it.

**NOT FOR PROFIT** — civic public good. Not a commercial product. No token. No fees to voters.

Effective date: [EFFECTIVE DATE]. Last updated: 24 November 2026. Version 3.

## 1. Definitions and interpretation

**1.1 Definitions.** In these Terms of Use (the “Terms”):

- “Operator”, “we”, “us” means [OPERATOR LEGAL NAME], a [ENTITY TYPE, e.g. municipality, cooperative, non-profit association] organized under the laws of [JURISDICTION], which runs this Node.
- “Service” means this ZK-Voting Node (repository name zk-voting): its public pages, accounts, registration, ballots, receipts, officer desks, APIs, and the emails it sends.
- “Civic vote” means an election run on the ZkVotingRollup contract on Ethereum: ballots are encrypted, counted only as a final sum, and decrypted by guardians.
- “Poll” means an informal election counted on this Node, with weaker privacy than a civic vote.
- “Officer” means a clerk, registrar, tally operator, guardian, or disqualification officer appointed for a jurisdiction on this Node.
- “You” means the person using the Service, and, where you act for a body, that body.

**1.2 Interpretation.** “Including” means “including without limitation”. Headings are for reading only. “Writing” includes electronic communications. Days are calendar days.

## 2. Acceptance of Terms

**2.1 Binding agreement.** By creating an account, checking “I agree”, or otherwise using the Service, you agree to these Terms. If you do not agree, do not use the Service.

**2.2 Capacity.** You confirm that (a) you are at least [MINIMUM AGE, e.g. 18] years old, or the voting age the hosting jurisdiction sets for the elections you join; (b) you may lawfully enter into these Terms; (c) if you act for a jurisdiction, union, cooperative, or other body, you have authority to bind it; and (d) what you provide is accurate. The Service does not ask for your date of birth.

**2.3 Recorded acceptance.** Registration requires an affirmative acceptance. The Node stores who accepted, when, the version, the SHA-256 of the PDF and of this markdown source, and whether a PDF copy was emailed.

**2.4 Additional rules.** An election may carry its own rules set by the hosting jurisdiction (eligibility, deadlines, reason codes). Where those rules and these Terms conflict on how that election runs, the election rules and the law that governs that election control.

## 3. Description of the Service

**3.1 What it is.** ZK-Voting lets a city, county, state, union, cooperative, or professional body keep a roll, run a ballot, and publish a result anyone can check, while each choice stays private.

**3.2 Civic votes.** A civic vote runs on one shared Ethereum contract. Your browser encrypts your ballot; an independent L2 operator batches ballots onto L1; only the final sum is decrypted, by a threshold of guardians, and only if enough ballots were cast. This Node relays your ballot and keeps a receipt, never your choice.

**3.3 Polls.** A poll is counted on this Node. It may publish interim blocks of counts and allows ranked choice. Its privacy is weaker than a civic vote’s, and the Service labels it so.

**3.4 Development status.** [DELETE WHEN NO LONGER TRUE:] This release uses a mock batch verifier on a local test chain. The batch validity circuit is not built, and roll membership is not yet proven in zero knowledge. Do not rely on this release for a binding election.

**3.5 Not legal, tax, or election-administration advice.** The Service is software. Running it does not by itself satisfy any elections statute. Rolls, tallies, and documents in the Service are produced by officers of the hosting jurisdiction, not by the software’s authors.

## 4. Accounts and registration

**4.1 One person, one account.** A person is unique on a Node. You may verify an email address, a passkey, a wallet, or an identity document as the Node offers. Do not create more than one account, and do not share your credentials.

**4.2 Security.** You are responsible for your passkey, your vote PIN, and access to your email. Tell the Operator at once if you suspect someone else is using your account.

**4.3 Registered is not eligible.** An officer decides eligibility under the election’s rules and may bar a registered person with a public reason code. Evidence stays off chain; only its hash is published.

**4.4 Suspension.** The Operator may suspend an account that breaks these Terms or the law, abuses the Service, or tries to deanonymize ballots. Disqualification from an election is a coded officer action, not a silent deletion.

## 5. Acceptable use

**5.1 Lawful use.** Use the Service only lawfully and as these Terms allow.

**5.2 Prohibited conduct.** You must not:

- vote in someone else’s name, buy or sell votes, or coerce or pay anyone to vote a certain way;
- try to learn how another person voted, or link a ballot, nullifier, or vote pass to a person;
- access accounts, officer tools, or systems you are not authorized to use;
- upload malicious code, or overload, probe, or disrupt the Service, the L2 operator, or the contract;
- post unlawful, defamatory, or harassing content in feedback, candidate information, or election text;
- misrepresent yourself as an officer, a guardian, or the Operator.

**5.3 Reporting.** Report suspected abuse or a security problem to [SECURITY CONTACT].

## 6. Ballots, receipts, and coercion resistance

**6.1 One ballot.** One ballot is kept per nullifier. In a civic vote a second ballot is refused. In a poll a second ballot is refused unless the election allows re-voting.

**6.2 Receipts.** A receipt holds hashes only (ballot hash, nullifier, batch and transaction references). It cannot prove how you voted, and your choice is never printed on a receipt, email, PDF, explorer row, or officer feed.

**6.3 Results.** A civic vote publishes only its final totals, after it closes. A poll may publish delayed interim blocks as its settings allow. The public monitor at `/outcomes` shows each election’s state and runs the public audit checks.

## 7. Intellectual property and licence

**7.1 Open source.** The software is licensed AGPL-3.0-or-later unless a file says otherwise. You may run, study, modify, and share it under that licence. Nothing in these Terms restricts rights the licence grants.

**7.2 Your content.** You keep what you submit. You grant the Operator a worldwide, royalty-free licence to store, display, and publish it as needed to run the Service and the elections you take part in.

**7.3 Feedback.** Feedback you submit through the Service, including at `/feedback`, becomes the property of [OPERATOR LEGAL NAME]. Where an assignment is not possible under applicable law, you grant [OPERATOR LEGAL NAME] a perpetual, irrevocable, worldwide, royalty-free licence to use, modify, and sublicense it. There is no obligation to use, credit, or pay for feedback.

**7.4 Names and marks.** [SITE NAME] and its logo belong to the Operator. “ZK-Voting” names the open-source project and implies no government endorsement.

**7.5 Copyright notices.** Send notices of claimed infringement to [COPYRIGHT AGENT NAME AND ADDRESS].

## 8. Privacy and data

**8.1 Privacy notice.** [LINK TO PRIVACY NOTICE, if separate.] This section summarizes what the Node keeps.

**8.2 What the Node stores.** Account handles, hashed authenticators, session ids, election records, registration records, and acceptance fingerprints. It does not put legal names, dates of birth, street addresses, or document numbers on chain; document numbers are hashed.

**8.3 What is public.** On a civic vote: identity commitments on the roll, nullifiers, encrypted ballots, the final sum, and the certified totals. None of these names you or reveals your choice.

**8.4 Cookies.** First-party, HttpOnly session cookies keep you signed in and complete email verification. Blocking them prevents sign-in.

**8.5 Email.** The Node sends verification codes, a PDF of these Terms on acceptance, optional hash-only receipts, and notices of changed Terms through [EMAIL PROVIDER, or “the operator’s mail server”].

**8.6 Retention and your rights.** [RETENTION PERIODS.] Depending on where you live you may have rights to access, correct, delete, or port your data, or object to processing. Contact [PRIVACY CONTACT]. Records already published to a blockchain cannot be erased.

**8.7 Transfers.** [STATE WHERE DATA IS HOSTED and any cross-border transfers.]

## 9. Blockchain risks

**9.1 Public chains.** Civic votes depend on Ethereum and on an L2 operator. Chains can congest, fork, upgrade, or fail, and a vote may be delayed or require the contract’s exit procedures.

**9.2 Smart contracts.** The contracts may contain defects despite testing and review. No assurance is given that none will be found.

**9.3 Your keys.** Your passkey and the secrets derived from it stay with you. The Operator cannot recover a lost passkey’s secrets; the Node can help you register again only where the election’s rules allow.

**9.4 No fees and no token.** Voters never pay gas or any fee to register, vote, or read results. The Service has no token and is not an investment.

## 10. Disclaimers

**10.1 As is.** THE SERVICE IS PROVIDED “AS IS” AND “AS AVAILABLE”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT, TO THE EXTENT THE LAW ALLOWS.

**10.2 Availability.** The Node may be down for maintenance, hosting failures, or events outside the Operator’s control. Published chain records remain enough for an independent auditor to check a civic vote.

**10.3 Third parties.** Hosting, email, RPC, and chain providers are outside the Operator’s control.

## 11. Limitation of liability

**11.1 Excluded damages.** TO THE EXTENT THE LAW ALLOWS, THE OPERATOR AND THE SOFTWARE’S AUTHORS AND CONTRIBUTORS ARE NOT LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOST DATA, ARISING FROM THE SERVICE.

**11.2 Cap.** [LIABILITY CAP, e.g. “The Operator’s total liability is limited to [AMOUNT].” Voters pay nothing, so a cap based on fees paid would be zero; choose a figure with counsel.]

**11.3 Non-excludable liability.** Nothing in these Terms excludes liability that the law does not allow to be excluded, including for fraud, or for death or personal injury caused by negligence.

## 12. Indemnity

If you host a Node, appoint officers, or invite people onto a roll, you will defend and indemnify the software’s volunteer authors against claims arising from your operation, your roll, or your officers’ actions, except to the extent caused by the authors’ fraud. [ADD ANY INDEMNITY BETWEEN VOTERS AND THE OPERATOR ONLY ON COUNSEL’S ADVICE.]

## 13. Force majeure

Neither party is liable for failure or delay caused by events beyond its reasonable control, including outages of hosting, network, or blockchain infrastructure. The affected party will take reasonable steps to resume.

## 14. Term and termination

**14.1** These Terms apply while you use the Service. You may stop at any time and ask the Operator to close your account.

**14.2** The Operator may suspend or close an account as section 4.4 describes.

**14.3** On closure, records published to a blockchain, acceptance records, and records the law requires the Operator to keep remain. Sections 7, 8, 10, 11, 12, 15, and 16 survive.

## 15. Governing law and disputes

**15.1 Governing law.** These Terms are governed by the laws of [GOVERNING LAW JURISDICTION], excluding conflict-of-law rules. If the Operator is a government body, mandatory public law of that government controls where it conflicts.

**15.2 Forum.** [COURTS OR OTHER FORUM, e.g. “the courts of [COUNTY, STATE]”.]

**15.3 Election contests.** A challenge to the conduct or result of an election belongs to the body that judges elections under the law that governs that election, not to any forum chosen in these Terms.

**15.4** [OPTIONAL: ARBITRATION OR CLASS-ACTION TERMS. The template includes none. Many civic operators should not add them; decide with counsel.]

## 16. General provisions

**16.1 Entire agreement.** These Terms, the AGPL licence, and any election rules referenced in section 2.4 are the whole agreement for using this Node.

**16.2 Severability.** If a provision is unenforceable, it is limited to the minimum extent needed and the rest remains in force.

**16.3 No waiver.** Not enforcing a provision once does not waive it later.

**16.4 Assignment.** You may not transfer these Terms. The Operator may transfer them to a successor body that takes over the Node.

**16.5 Notices.** Notices to you go to the email on your account. Notices to the Operator go to the address in section 18.

**16.6 Electronic records.** You agree to receive these Terms and related notices electronically, including a PDF of the current Terms when you accept them.

**16.7 No third-party beneficiaries,** except the software’s authors under sections 11 and 12.

## 17. Changes to these Terms

The Operator may update these Terms. The version and date above will change. The Node fingerprints the exact PDF bytes built from this markdown source, and the markdown itself, with SHA-256. When the fingerprint changes, the Node emails account holders a PDF of the new Terms and asks them to accept it at next sign-in. Earlier acceptances stay on file with the fingerprint that was current then. [NOTICE PERIOD before a material change takes effect, e.g. 30 days.]

## 18. Contact

- General questions: [GENERAL CONTACT EMAIL]
- Privacy: [PRIVACY CONTACT]
- Security: [SECURITY CONTACT]
- Legal notices: [POSTAL ADDRESS FOR LEGAL NOTICES]

Questions about a live election go to the hosting clerk. Never send passkey secrets, seed phrases, document numbers, or ballot choices by email.

## 19. Language

These Terms are written in English, and the English text controls. Translations of the interface, emails, or help text are for convenience and do not change these Terms. [ADD OR CHANGE THE CONTROLLING LANGUAGE if the hosting jurisdiction requires.]

NOT FOR PROFIT — civic public good. Not a commercial product.
