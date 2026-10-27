# Future research: vote delegation

> **Status: not planned for implementation; open research question.**
> Nothing in this repository implements delegation today. This page records the idea, where it could fit, and why it is risky, so that any future work starts from the same trade-offs.

## The idea

MakerDAO-style delegation: a voter calls `delegate(delegate)` to lend their voting weight to someone else and `undelegate()` to take it back.

- **Optional per election.** Delegation would be off unless the jurisdiction approves it when the election is constructed. Each jurisdiction decides whether its rules allow it.
- **Undelegate at any time.** A delegator can withdraw whenever they want. But weight that has already been used in a vote cannot vote a second time, whether by the delegate or by the delegator.
- **Effective weight counts only eligible delegators.** A delegate's weight is the number of delegators who are eligible and not disqualified for that election (or question), not the raw number of delegations. Example: 100 people delegate to one delegate, but only 50 of them qualify to vote, so the delegate's effective weight is 50.

## Where it fits: ERC-20 token polls

Delegation is a natural fit for the token polls described in [`POLLS.md`](../POLLS.md):

- Weight is already public there and comes from tokens held, so delegation reveals nothing new.
- Weight already depends on holding tokens through close. A delegate contract where holders lock tokens and can withdraw at any time maps cleanly onto that rule: whatever is still delegated at close is what counts.

**Recommendation if it is ever built:** token polls only, off by default, and enabled per poll by the poll's creator.

## Risks for anonymous civic elections

1. **Delegation is a verifiable receipt.** "I gave my vote to X, and you can check it" is exactly the kind of proof a vote buyer or coercer wants. It breaks receipt-freeness, which the civic design works hard to protect (see [`THREAT_MODEL.md`](../THREAT_MODEL.md) and [how voters' privacy is protected](../how_voters_privacy_is_protected.md)).
2. **Eligibility and disqualification must be enforced per delegator, not per delegate.** Doing that on-chain links each delegator's identity to the delegate. Doing it privately means every delegator produces a zero-knowledge proof of eligibility that consumes their own nullifier and adds one unit of weight to the delegate. That requires new circuits, a new trusted-setup ceremony and a new audit, roughly as large as the core voting proof.
3. **Timing and double-vote edge cases.** Each case needs a firm rule, and each rule is one more thing to get wrong:
   - A delegator undelegates and then votes directly.
   - A delegate votes, and then delegators undelegate.
   - A delegator is disqualified after their weight was already used.

   Candidate rules: **weight locks once it is used**, and **a direct vote overrides a delegation** (if it is cast before the delegated weight is used).
4. **Concentration of power.** A few large delegates become obvious targets for bribery and pressure, which works against one person, one vote.

## Options if it is pursued

- **Token polls only** (recommended): moderate work, low risk, as described above.
- **A non-anonymous "proxy voting" mode** for jurisdictions that want it: clearly labeled as not secret, so voters know a proxy vote is public and traceable.
- **An anonymous civic version only after a full design and threat model**, written and reviewed before any code, covering the circuits, the nullifier rules, the edge cases above and coercion resistance.
