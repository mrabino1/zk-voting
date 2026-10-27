# Toy ceremony fixtures (tests only)

**NOT FOR PROFIT** — civic public good. Not a commercial product.

These files exist so the ceremony tests and the a11y seed can run a complete phase 2 in seconds. **They are not trusted and must never be used for a real circuit.**

| File | SHA-256 | What |
| --- | --- | --- |
| `toy.r1cs` | `85342b9193ec76169c4331f90dae3cf4b037a26ab1d0f03e76e0513d84d8ea45` | One-constraint circuit (`c <== a * b`) |
| `toy_phase2.ptau` | `cbc0a81821de303eed70e924bc621192118d372dd7b310b36922eef277f01a08` | Power-4 powers of tau, prepared for phase 2, made locally with **published** entropy |

Anyone can recreate the toxic waste from the published entropy, so any key built on these files can be forged. That is fine for tests and nothing else.
