#!/usr/bin/env python3
"""Report half of scripts/get-gas-economics.sh. Not meant to be run directly.

NOT FOR PROFIT — civic public good, not a commercial product.

Inputs come from environment variables set by the bash wrapper (GE_*), so
nothing here names a host, a chain, or a price source.
"""
import glob
import json
import os
import re
import sys

EIP170 = 24576          # pre-Glamsterdam runtime cap
EIP3860 = 49152         # pre-Glamsterdam initcode cap
EIP7954_RUNTIME = 65536 # Glamsterdam EIP-7954 runtime cap
EIP7954_INIT = 131072   # Glamsterdam EIP-7954 initcode cap
TIGHT = 0.90
# One hourly settlement per open hour, then the final batch and one supplementary batch.
TAIL_BATCHES = 2
# The prover posts one submitBatch per this many sealed L2 blocks (L2_BATCH_SIZE).
SEQUENCER_BATCH_BLOCKS = 4
# Producer period when the mempool stays full (genesis block time).
BLOCK_PERIOD_SECONDS = 2
# Quoted when no L1 node answered. 1 gwei and 30 gwei are that figure divided by 10 and times 3.
REF_GWEI = 10.0

# Contracts that settle on L1 (Ethereum). Everything else is the election
# stack, which runs on the civic L2 (or any EVM chain it is deployed to).
L1_CONTRACTS = {"RollupSettlement", "L1TallyMirror", "ZkVotingMailbox"}

# The calls that make up one election, in lifecycle order.
KEY_OPS = [
    ("L2", "JurisdictionRegistry", "createJurisdiction", "once per jurisdiction"),
    ("L2", "ElectionFactory", "createElection", "once per election"),
    ("L2", "PasskeyAccountFactory", "createAccount", "once per voter account"),
    ("L2", "VoterRegistry", "register", "per voter"),
    ("L2", "BallotInbox", "submitVote", "per ballot (reverts once disclosure interval is set)"),
    ("L2", "BallotInbox", "submitVoteBatch", "per inbox batch (at most 64 ballots)"),
    ("L2", "BallotInbox", "submitVoteWithClearance", "per ballot (clearance path)"),
    ("L2", "Tally", "submitTally", "once per election"),
    ("L2", "Tally", "submitOpenedTally", "once per election (opened)"),
    ("L2", "Tally", "postInterimResult", "POLL, per published hour"),
    ("L2", "Tally", "disclose", "POLL, per published hour"),
    ("L2", "Tally", "submitDecryption", "VOTE, once after cutoff"),
    ("L1", "RollupSettlement", "submitBatch", "per settled batch"),
    ("L1", "RollupSettlement", "submitHourlyBatch", "per open hour"),
    ("L1", "RollupSettlement", "submitFinalBatch", "once, at cutoff"),
    ("L1", "RollupSettlement", "submitSupplementaryBatch", "once, at tally time"),
    ("L1", "L1TallyMirror", "postResult", "once per election (legacy slot)"),
    ("L1", "L1TallyMirror", "postCertifiedResult", "once per election (certified)"),
]


def env(name, default=""):
    return os.environ.get(name, default)


def fnum(name):
    v = env(name).strip()
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        sys.exit(f"error: {name}={v!r} is not a number")


def fmt_int(n):
    return "n/a" if n is None else f"{int(round(n)):,}"


def fmt_eth(x):
    if x is None:
        return "n/a"
    if x == 0:
        return "0"
    return f"{x:.6f}" if x >= 0.000001 else f"{x:.2e}"


def fmt_usd(x):
    if x is None:
        return "n/a"
    if x < 0.01:
        return f"${x:.4f}"
    return f"${x:,.2f}"


def cost(gas, gwei, usd):
    if gas is None or gwei is None:
        return None, None
    eth = gas * gwei * 1e-9
    return eth, (eth * usd if usd is not None else None)


def rule(title):
    print()
    print(title)
    print("-" * len(title))


# --- artifacts ---------------------------------------------------------------
def load_artifacts(out_dir, sc_dir):
    """Concrete contracts compiled from src/, discovered from out/."""
    found = {}
    libraries = []
    settings = None
    for path in sorted(glob.glob(os.path.join(out_dir, "*.sol", "*.json"))):
        try:
            art = json.load(open(path))
        except Exception:
            continue
        meta = art.get("metadata") or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = {}
        target = (meta.get("settings") or {}).get("compilationTarget") or {}
        if not target:
            continue
        src, name = next(iter(target.items()))
        if not src.startswith("src/"):
            continue
        if not os.path.isfile(os.path.join(sc_dir, src)):
            continue  # stale artifact from a renamed or deleted source
        runtime = ((art.get("deployedBytecode") or {}).get("object") or "")
        init = ((art.get("bytecode") or {}).get("object") or "")
        runtime = runtime[2:] if runtime.startswith("0x") else runtime
        init = init[2:] if init.startswith("0x") else init
        if not runtime:
            continue  # interface or abstract
        # Solidity library runtime opens with PUSH20 <own address> ADDRESS EQ
        # (the call-protection guard); artifacts carry the zero placeholder.
        # Internal-only libraries compile to a bare revert stub plus metadata.
        has_fns = any(e.get("type") == "function" for e in art.get("abi") or [])
        stub = len(runtime) // 2 <= 64 and not has_fns
        if stub or runtime.lower().startswith("73" + "00" * 20 + "30"):
            libraries.append(name)  # linked in or inlined; not a deploy line
            continue
        found[name] = {
            "source": src,
            "runtime": len(runtime) // 2,
            "init": len(init) // 2,
        }
        if settings is None:
            settings = meta.get("settings") or {}
    return found, settings or {}, sorted(libraries)


def deploy_gas_from_record(record_path):
    if not record_path or not os.path.isfile(record_path):
        return {}, None
    try:
        rec = json.load(open(record_path))
    except Exception:
        return {}, None
    out = {}
    for tx in (rec.get("gas") or {}).get("transactions") or []:
        if tx.get("type") == "CREATE" and tx.get("contract") and tx.get("gasUsed"):
            out.setdefault(tx["contract"], tx["gasUsed"])
    return out, rec


def estimate_deploy_gas(init_bytes, runtime_bytes):
    # Floor only: tx base + CREATE + code deposit + initcode calldata.
    # Constructor storage writes are not included.
    return 21000 + 32000 + 200 * runtime_bytes + 16 * init_bytes


def size_flag(runtime, init):
    """OVER fails the run. PRE fits Glamsterdam and exceeds today's cap."""
    over_post = runtime > EIP7954_RUNTIME or init > EIP7954_INIT
    over_pre = runtime > EIP170 or init > EIP3860
    tight = runtime / EIP7954_RUNTIME >= TIGHT or init / EIP7954_INIT >= TIGHT
    if over_post:
        return "OVER"
    if over_pre:
        return "PRE"
    if tight:
        return "TIGHT"
    return ""


def whole(name, default=None):
    v = fnum(name)
    if v is None:
        return default
    if v < 0 or v != int(v):
        sys.exit(f"error: {name}={v!r} is not a whole number")
    return int(v)


def l1_batch_count(hours):
    """Hourly settlement, the final batch, and one supplementary batch."""
    return hours + TAIL_BATCHES


def busy_sequencer_batches(hours):
    """L1 submitBatch calls if a block is sealed every period and posted in groups of 4."""
    if hours <= 0:
        return 0
    blocks = hours * 3600 // BLOCK_PERIOD_SECONDS
    return (blocks + SEQUENCER_BATCH_BLOCKS - 1) // SEQUENCER_BATCH_BLOCKS


def call_median(ops, contract, fn):
    st = ops.get((contract, fn))
    if not st or st.get("median") is None:
        return None
    return int(st["median"])


def first_median(ops, names):
    """First measured (contract, function) in names. Returns (label, gas) or (None, None)."""
    for contract, fn in names:
        gas = call_median(ops, contract, fn)
        if gas is not None:
            return f"{contract}.{fn}", gas
    return None, None


def fmt_usd_cell(dollars):
    return "—" if dollars is None else fmt_usd(dollars)


def quote_gwei(live_gwei):
    """Gas price for the L1 bill, and a one-line scale note when it is not live."""
    if live_gwei is not None:
        return live_gwei, None
    return REF_GWEI, (
        f"No L1 node answered. Dollars use {REF_GWEI:g} gwei and are not a quote. "
        "At 1 gwei they are one tenth. At 30 gwei they are three times."
    )


# --- gas report ----------------------------------------------------------------
def load_gas_report(path):
    if not path or not os.path.isfile(path):
        return {}
    text = open(path, encoding="utf-8", errors="replace").read()
    start = text.find("[")
    if start < 0:
        return {}
    try:
        data = json.loads(text[start:text.rfind("]") + 1])
    except Exception:
        return {}
    ops = {}
    for entry in data:
        cname = (entry.get("contract") or "").split(":")[-1]
        for sig, st in (entry.get("functions") or {}).items():
            fname = sig.split("(")[0]
            key = (cname, fname)
            prev = ops.get(key)
            # Overloads: keep the most-called signature.
            if prev is None or st.get("calls", 0) > prev.get("calls", 0):
                ops[key] = dict(st, signature=sig)
    return ops


def _line(label, gas, gwei, usd):
    if gas is None:
        print(f"  {label:<52} {'unmeasured':>14}")
        return
    eth, dollars = cost(gas, gwei, usd)
    print(f"  {label:<52} {fmt_int(gas):>14} gas   {fmt_eth(eth):>12} ETH   {fmt_usd(dollars):>12}")


def print_scenarios(ops, voters, ballots, hours, batches, groth16, l1_gwei, l2_gwei, usd, total_l1_gas):
    del l2_gwei  # the civic L2 has no gas token; this section prices Ethereum only
    gwei, scale = quote_gwei(l1_gwei)
    batch_label, batch_gas = first_median(ops, (
        ("RollupSettlement", "submitBatch"),
        ("RollupSettlement", "submitHourlyBatch"),
    ))
    cert_label, cert_gas = first_median(ops, (
        ("L1TallyMirror", "postCertifiedResult"),
        ("L1TallyMirror", "postResult"),
    ))

    rule("L1 bill: one-time deploy, then one settlement per hour")
    print("Your L2 runs on your own VPS. Registration, ballots, the tally, a poll's hourly")
    print("disclosure, and a vote's decryption are not Ethereum transactions. That gas costs")
    print("$0. A poll and a vote post the same L1 transactions. How many ballots were cast")
    print("does not change the count. How many hours voting stays open does.")
    print(f"ETH/USD is {fmt_usd(usd)}." + (f" {scale}" if scale else f" L1 gas is {gwei:.3f} gwei."))
    print("Voters pay nothing. Batch posting is the sequencer, prover, or admin.")

    rule("Once, for the whole system")
    print("Deploy RollupSettlement, L1TallyMirror, and ZkVotingMailbox once. Every later")
    print("election posts into those contracts. It does not deploy them again.")
    _line("one-time L1 deploy", total_l1_gas, gwei, usd)

    settlements = batches
    rule(f"During one election: {hours:,} hour(s) open, {ballots:,} ballots")
    print(f"One L1 settlement for each open hour, then one final batch and one supplementary")
    print(f"batch ({TAIL_BATCHES} after the hours). Then one certification. "
          f"{hours:,} hour(s) → {settlements:,} settlements + 1 certification "
          f"= {settlements + 1:,} Ethereum transactions.")
    print(f"{ballots:,} ballots share those settlements. They do not add a transaction each.")
    if batch_gas is None or cert_gas is None:
        print("Settlement gas was not measured. Add --measure to price the transactions. The counts above stand.")
    else:
        _line(f"{settlements:,} × {batch_label}", settlements * batch_gas, gwei, usd)
        _line(f"1 × {cert_label}", cert_gas, gwei, usd)
        mock_total = settlements * batch_gas + cert_gas
        _line("election total, mock proof", mock_total, gwei, usd)
        print(f"Each settlement is priced at the measured median of {batch_label}.")
        print("The final and supplementary batches were not measured on their own, so they use that median.")
        print("The forge tests use a mock verifier, so this total does not include a real proof.")
        if groth16:
            proof_gas = settlements * groth16
            _line(f"real proof allowance, {groth16:,} gas × {settlements:,} settlements", proof_gas, gwei, usd)
            _line("election total with that allowance", mock_total + proof_gas, gwei, usd)
            print("The allowance is once per L1 settlement, not once per ballot. Pass --groth16-gas 0 to hide it.")

    rule("Same L1 bill at other lengths (poll and vote match)")
    print(f"{'hours':>6}  {'settlements':>12}  {'plus cert':>9}  {'L1 txs':>8}  {'mock proof':>14}  {'with real proof':>16}")
    windows = [1, 12, 24, 72]
    if hours not in windows:
        windows.append(hours)
    for window in sorted(windows):
        n = l1_batch_count(window) if window != hours else settlements
        # Keep the highlighted window on the operator's --batches override.
        txs = n + 1
        if batch_gas is None or cert_gas is None:
            mock_usd, real_usd = "—", "—"
        else:
            mock_gas = n * batch_gas + cert_gas
            mock_usd = fmt_usd(cost(mock_gas, gwei, usd)[1])
            real_usd = fmt_usd(cost(mock_gas + n * groth16, gwei, usd)[1]) if groth16 else "hidden"
        mark = "  this election" if window == hours else ""
        print(f"{window:>6}  {n:>12,}  {1:>9}  {txs:>8,}  {mock_usd:>14}  {real_usd:>16}{mark}")
    print("A 1-hour poll and a 1-hour vote are the same row. A longer window adds one")
    print("settlement per extra hour. More ballots do not add a row and do not add a column.")

    busy = busy_sequencer_batches(hours)
    rule("If the prover posts every 4 blocks instead of once per hour")
    print(f"The VPS prover sends RollupSettlement.submitBatch once per {SEQUENCER_BATCH_BLOCKS} sealed")
    print(f"L2 blocks, and only when L1_RPC, the settlement address, and a key are all set.")
    print(f"Left unset, this bill is $0 and the proofs stay on the VPS.")
    print(f"If the chain seals a block every {BLOCK_PERIOD_SECONDS}s for all {hours:,} hour(s), that is")
    print(f"{busy:,} L1 transactions (one every {SEQUENCER_BATCH_BLOCKS * BLOCK_PERIOD_SECONDS}s), "
          f"not the {settlements:,} hourly settlements above.")
    if batch_gas is not None and busy:
        busy_gas = busy * batch_gas
        _line(f"{busy:,} × {batch_label} (no certification)", busy_gas, gwei, usd)
        if groth16:
            _line(f"plus {groth16:,} gas × {busy:,} real proofs", busy * groth16, gwei, usd)
            _line("busy-prover total with that allowance", busy_gas + busy * groth16, gwei, usd)
        print("That schedule does not batch the hour. It is the cost of posting as fast as the chain moves.")


def main():
    out_dir = env("GE_OUT_DIR")
    sc_dir = env("GE_SC_DIR")
    l1_gwei = fnum("GE_L1_GWEI")
    l1_base = fnum("GE_L1_BASEFEE_GWEI")
    l2_gwei = fnum("GE_L2_GWEI")
    usd = fnum("GE_ETH_USD")
    voters = whole("GE_VOTERS", 1000)
    ballots = whole("GE_BALLOTS", voters)
    hours = whole("GE_HOURS", 12)
    batches = whole("GE_BATCHES", l1_batch_count(hours))
    groth16 = whole("GE_GROTH16_EXTRA_GAS", 0)
    ops_filter = env("GE_OPS_FILTER")
    status = 0

    print("zk-voting gas economics")
    print("=======================")
    print(f"L1 node:     {env('GE_L1_DESC', 'n/a')}")
    if l1_gwei is not None:
        extra = f" (base fee {l1_base:.3f} gwei)" if l1_base is not None else ""
        print(f"L1 gas:      {l1_gwei:.3f} gwei{extra}  [{env('GE_L1_GAS_SRC')}]")
    else:
        print(f"L1 gas:      n/a (L1 dollars below use {REF_GWEI:g} gwei)")
    if env("GE_L2_DESC"):
        print(f"L2 node:     {env('GE_L2_DESC')}")
    if l2_gwei is not None:
        print(f"L2 gas:      {l2_gwei:.3f} gwei  [{env('GE_L2_GAS_SRC')}]")
    print(f"ETH/USD:     {fmt_usd(usd) if usd is not None else 'n/a'}  [{env('GE_PRICE_SRC', 'none')}]")

    # Sizes ------------------------------------------------------------------
    arts, settings, libraries = load_artifacts(out_dir, sc_dir)
    if not arts:
        print(f"\nerror: no compiled contracts under {out_dir}. Run: (cd ../smart-contracts && forge build)", file=sys.stderr)
        return 1
    opt = settings.get("optimizer") or {}
    print(f"Compiler:    optimizer={'on' if opt.get('enabled') else 'off'} runs={opt.get('runs', 'n/a')} "
          f"viaIR={'on' if settings.get('viaIR') else 'off'} evm={settings.get('evmVersion', 'n/a')}")

    rec_gas, rec = deploy_gas_from_record(env("GE_RECORD"))
    if rec:
        print(f"Deploy gas:  measured from {env('GE_RECORD_DESC')} (chain {rec.get('chainId')}, {rec.get('target')})")
    else:
        print("Deploy gas:  floor estimate from bytecode size (run scripts/deploy.sh for measured gas)")

    rule("Bytecode size. Deploy target is Glamsterdam EIP-7954 "
         "(runtime 65,536 B, initcode 131,072 B)")
    print("Today's mainnet caps remain EIP-170 (24,576 B runtime) and EIP-3860 (49,152 B initcode)")
    print("until Glamsterdam. PRE exceeds today's cap and fits the Glamsterdam cap.")
    hdr = (f"{'contract':<26} {'layer':<5} {'runtime B':>10} {'%170':>6} {'%64Ki':>6} "
           f"{'init B':>9} {'%3860':>6} {'%128Ki':>6}  {'deploy gas':>12} {'L1 ETH':>10} {'L1 USD':>10}  flag")
    print(hdr)
    flagged = []
    total_gas = {"L1": 0, "L2": 0}
    for name in sorted(arts, key=lambda n: (n not in L1_CONTRACTS, n)):
        a = arts[name]
        layer = "L1" if name in L1_CONTRACTS else "L2"
        p170 = a["runtime"] / EIP170
        p64 = a["runtime"] / EIP7954_RUNTIME
        p3860 = a["init"] / EIP3860
        p128 = a["init"] / EIP7954_INIT
        flag = size_flag(a["runtime"], a["init"])
        if flag == "OVER":
            status = 1
        if flag:
            flagged.append((name, flag, a["runtime"], a["init"]))
        if name in rec_gas:
            gas, mark = rec_gas[name], ""
        else:
            gas, mark = estimate_deploy_gas(a["init"], a["runtime"]), "~"
        total_gas[layer] += gas
        eth, dollars = cost(gas, l1_gwei, usd)
        print(f"{name:<26} {layer:<5} {a['runtime']:>10,} {p170:>6.1%} {p64:>6.1%} "
              f"{a['init']:>9,} {p3860:>6.1%} {p128:>6.1%}  "
              f"{mark + fmt_int(gas):>12} {fmt_eth(eth):>10} {fmt_usd(dollars):>10}  {flag}")
    print("(~ = size-based floor, not measured; L1 cost = gas x L1 gas price)")
    if libraries:
        print("Libraries (inlined, no deploy line): " + ", ".join(libraries))
    closest = sorted(arts.items(), key=lambda kv: kv[1]["runtime"], reverse=True)[:3]
    print("Closest to the Glamsterdam runtime cap: "
          + ", ".join(f"{n} {v['runtime'] / EIP7954_RUNTIME:.1%}" for n, v in closest))
    for n, f, runtime, init in flagged:
        if f == "OVER":
            print(f"ERROR: {n} exceeds the Glamsterdam cap "
                  f"({runtime:,} B runtime, {init:,} B initcode) and cannot be deployed")
        elif f == "PRE":
            print(f"PRE: {n} exceeds today's cap ({runtime:,} B runtime, {init:,} B initcode) "
                  "and fits EIP-7954. Deployable once Glamsterdam is active.")
        else:
            print(f"WARNING: {n} is TIGHT (>= {TIGHT:.0%} of the Glamsterdam cap)")
    for layer in ("L1", "L2"):
        eth, dollars = cost(total_gas[layer], l1_gwei, usd)
        print(f"Sum of {layer} rows: {fmt_int(total_gas[layer])} gas = {fmt_eth(eth)} ETH {fmt_usd(dollars)} at L1 gas price"
              + (" (includes alternatives, e.g. both verifiers and hashers)" if layer == "L2" else ""))
    print("L1 rows are one deployment of the shared settlement, mirror, and mailbox.")
    print("Later elections post batches to those contracts. They do not deploy them again.")
    print("The L2 sum is the shared election stack, also once, not once per election.")
    if rec and (rec.get("gas") or {}).get("total"):
        g = rec["gas"]
        eth, dollars = cost(g["total"], l1_gwei, usd)
        print(f"Recorded {rec.get('script', 'deploy')} run: {fmt_int(g['total'])} gas over "
              f"{len(g.get('transactions') or [])} txs = {fmt_eth(eth)} ETH {fmt_usd(dollars)} at L1 gas price")

    # Measured calls -------------------------------------------------------------
    ops = {}
    if env("GE_GAS_REPORT"):
        ops = load_gas_report(env("GE_GAS_REPORT"))
        if not ops:
            print("\nwarning: forge gas report was empty or unreadable", file=sys.stderr)
    if ops:
        l2_price = l2_gwei if l2_gwei is not None else l1_gwei
        l2_label = "L2 gas price" if l2_gwei is not None else "L1 gas price (no L2 price given)"
        rule("Per-call gas (forge test --gas-report, median; tests use MockVerifier)")
        print(f"{'layer':<5} {'contract.function':<52} {'median':>10} {'max':>10} {'calls':>6} {'ETH':>10} {'USD':>10}  when")
        for layer, c, f, when in KEY_OPS:
            st = ops.get((c, f))
            if st is None:
                continue
            gwei = l1_gwei if layer == "L1" else l2_price
            eth, dollars = cost(st.get("median"), gwei, usd)
            print(f"{layer:<5} {c + '.' + f:<52} {fmt_int(st.get('median')):>10} {fmt_int(st.get('max')):>10} "
                  f"{st.get('calls', 0):>6} {fmt_eth(eth):>10} {fmt_usd(dollars):>10}  {when}")
        missing = [f"{c}.{f}" for _, c, f, _ in KEY_OPS if (c, f) not in ops]
        if missing:
            print("not exercised by the selected tests: " + ", ".join(missing))
        print(f"L1 rows priced at L1 gas price; L2 rows at {l2_label}.")
        print("L2 calls are not an Ethereum bill when the election runs on your own L2. The L1 section below is the bill.")
        if ops_filter:
            rx = re.compile(ops_filter)
            rule(f"All measured functions matching /{ops_filter}/")
            for (c, f), st in sorted(ops.items()):
                if rx.search(f"{c}.{f}"):
                    print(f"{c + '.' + f:<52} median {fmt_int(st.get('median')):>10}  max {fmt_int(st.get('max')):>10}  calls {st.get('calls', 0)}")

    print_scenarios(ops, voters, ballots, hours, batches, groth16, l1_gwei, l2_gwei, usd, total_gas["L1"])
    return status


if __name__ == "__main__":
    sys.exit(main())
