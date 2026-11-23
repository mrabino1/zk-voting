#!/usr/bin/env python3
"""Report half of scripts/get-gas-economics.sh. Not meant to be run directly.

NOT FOR PROFIT — civic public good, not a commercial product.

Prices one civic vote on ZkVotingRollup (smart-contracts/docs/ROLLUP.md). Every
transaction in the model is an Ethereum L1 transaction; polls run on the Node
and cost no gas. Inputs come from environment variables set by the bash wrapper
(GE_*), so nothing here names a host, a chain, or a price source.
"""
import glob
import json
import math
import os
import re
import sys

EIP170 = 24576          # pre-Glamsterdam runtime cap
EIP3860 = 49152         # pre-Glamsterdam initcode cap
EIP7954_RUNTIME = 65536 # Glamsterdam EIP-7954 runtime cap
EIP7954_INIT = 131072   # Glamsterdam EIP-7954 initcode cap
TIGHT = 0.90
# Quoted when no L1 node answered. 1 gwei and 30 gwei are that figure divided by 10 and times 3.
REF_GWEI = 10.0

# Intrinsic cost of every L1 transaction; forge's gas report leaves it out.
TX_BASE = 21000
# The operator seals a batch every L2_BATCH_SECONDS when there is work, with at most
# this many ballots (voting_node/l2/rollup/operator.mjs).
MAX_BALLOTS_PER_BATCH = 256
BATCH_SECONDS = 10
# A BALLOT op in pubdata: type (1) + election id (4) + nullifier (32) + commitment (32).
BALLOT_PUBDATA_BYTES = 69
CALLDATA_GAS_PER_BYTE = 16
# Enqueueing a voter on the roll (registerVoters): measured 346,611 gas for 70
# commitments in test/PriorityQueue.t.sol, plus 32 bytes of calldata each.
REGISTER_GAS_PER_VOTER = 4950 + 32 * CALLDATA_GAS_PER_BYTE
# The forge tests run elections with 3 options, 3 guardians and k = 2. Decryption
# shares and result checks scale with the option count.
MEASURED_OPTIONS = 3

# Not part of the rollup deployment: a test-only verifier, and the optional
# signal-poll token (script/DeploySignalToken.s.sol).
TEST_ONLY = {"MockBatchVerifier"}
OPTIONAL = {"SignalVotesToken", "SignalVotesWrapper"}

# The calls of one civic vote, in lifecycle order: (contract, function, when).
KEY_OPS = [
    ("ZkVotingRollup", "setOperator", "governor, once per operator"),
    ("ZkVotingRollup", "createJurisdiction", "governor, once per jurisdiction"),
    ("ZkVotingRollup", "setClerk", "jurisdiction admin, once per clerk"),
    ("ZkVotingRollup", "createElection", "clerk (the Node), once per election"),
    ("ZkVotingRollup", "commitGuardian", "once per guardian (relayed by the Node)"),
    ("ZkVotingRollup", "finalizeKey", "once per election"),
    ("ZkVotingRollup", "registerVoters", "per roll sync (grows with the voters sent)"),
    ("ZkVotingRollup", "disqualify", "per disqualification"),
    ("ZkVotingRollup", "commitBatch", "operator, per batch"),
    ("ZkVotingRollup", "verifyBatch", "per batch (mock verifier in tests)"),
    ("ZkVotingRollup", "executeBatches", "per batch"),
    ("ZkVotingRollup", "forceBallot", "only when the operator refuses a ballot"),
    ("ZkVotingRollup", "closeElection", "once, after the cutoff"),
    ("ZkVotingRollup", "postDecryptionShares", "once per guardian, k needed"),
    ("ZkVotingRollup", "finalizeResult", "once per election"),
    ("ZkVotingRollup", "activateDesertMode", "only if the operator ignores the queue"),
    ("ZkVotingRollup", "desertClose", "desert mode only, per open election"),
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


def batch_range(ballots, hours):
    """Fewest batches (full ones) and most (one ballot each, as often as the operator seals)."""
    if ballots <= 0:
        return 0, 0
    low = math.ceil(ballots / MAX_BALLOTS_PER_BATCH)
    high = max(low, min(ballots, hours * 3600 // BATCH_SECONDS))
    return low, high


def print_scenarios(ops, voters, ballots, hours, batches, groth16, guardians, threshold, options, gwei_live, usd, deploy_gas):
    gwei, scale = quote_gwei(gwei_live)
    need = {
        "create": call_median(ops, "ZkVotingRollup", "createElection"),
        "commitGuardian": call_median(ops, "ZkVotingRollup", "commitGuardian"),
        "finalizeKey": call_median(ops, "ZkVotingRollup", "finalizeKey"),
        "commit": call_median(ops, "ZkVotingRollup", "commitBatch"),
        "verify": call_median(ops, "ZkVotingRollup", "verifyBatch"),
        "execute": call_median(ops, "ZkVotingRollup", "executeBatches"),
        "close": call_median(ops, "ZkVotingRollup", "closeElection"),
        "shares": call_median(ops, "ZkVotingRollup", "postDecryptionShares"),
        "finalize": call_median(ops, "ZkVotingRollup", "finalizeResult"),
    }

    rule("L1 bill for one civic vote")
    print("Every line is an Ethereum transaction. Voters pay nothing: the Node account pays for")
    print("publish, roll sync, guardian relays, close and finalize; the operator pays for batches.")
    print("Polls run on the Node and cost no gas.")
    print(f"ETH/USD is {fmt_usd(usd)}." + (f" {scale}" if scale else f" L1 gas is {gwei:.3f} gwei."))
    print(f"Election: {voters:,} voters on the roll, {ballots:,} ballots, open {hours:,} hour(s),")
    print(f"{options} options, {guardians} guardians, k = {threshold}. Each call adds {TX_BASE:,} gas of intrinsic cost.")

    rule("Once, for the whole system")
    print("ZkVotingRollup and its verifiers deploy once per chain and serve every jurisdiction.")
    _line("one-time deploy (rollup + verifiers)", deploy_gas, gwei, usd)

    missing = [k for k, v in need.items() if v is None]
    if missing:
        print()
        print("Per-call gas was not measured (" + ", ".join(missing) + "). Add --measure to price an election.")
        return

    opt_scale = options / MEASURED_OPTIONS
    setup = need["create"] + TX_BASE + guardians * (need["commitGuardian"] + TX_BASE) + need["finalizeKey"] + TX_BASE
    roll = voters * REGISTER_GAS_PER_VOTER + TX_BASE
    per_batch = need["commit"] + need["verify"] + need["execute"] + 3 * TX_BASE + groth16
    ballot_data = ballots * BALLOT_PUBDATA_BYTES * CALLDATA_GAS_PER_BYTE
    close = need["close"] + TX_BASE + per_batch  # the CLOSE request rides one more batch
    result = threshold * (need["shares"] * opt_scale + TX_BASE) + need["finalize"] * opt_scale + TX_BASE

    if batches is not None:
        low = high = batches
    else:
        low, high = batch_range(ballots, hours)

    rule("One election")
    _line("publish and key ceremony", setup, gwei, usd)
    _line(f"roll: {voters:,} voters enqueued", roll, gwei, usd)
    _line(f"ballot pubdata: {ballots:,} × {BALLOT_PUBDATA_BYTES} bytes", ballot_data, gwei, usd)
    if low == high:
        _line(f"batches: {low:,} × commit + verify + execute", low * per_batch, gwei, usd)
    else:
        _line(f"batches, fewest: {low:,} full batches", low * per_batch, gwei, usd)
        _line(f"batches, most: {high:,} (one every {BATCH_SECONDS}s)", high * per_batch, gwei, usd)
    _line("close (plus the batch that carries it)", close, gwei, usd)
    _line(f"decrypt the sum: {threshold} guardians' shares + finalize", result, gwei, usd)
    fixed = setup + roll + ballot_data + close + result
    _line("election total, fewest batches", fixed + low * per_batch, gwei, usd)
    if high != low:
        _line("election total, most batches", fixed + high * per_batch, gwei, usd)

    print()
    print(f"Batch cost includes {groth16:,} gas for a real batch proof (--groth16-gas; the tests use a")
    print("mock verifier and the batch circuit is not built, so that figure is an allowance).")
    print(f"Decryption shares and the result check were measured at {MEASURED_OPTIONS} options and are scaled")
    print("linearly to the option count. Registration is the enqueue cost only; the operator then")
    print("carries those requests in batches already counted above.")


def main():
    out_dir = env("GE_OUT_DIR")
    sc_dir = env("GE_SC_DIR")
    l1_gwei = fnum("GE_L1_GWEI")
    l1_base = fnum("GE_L1_BASEFEE_GWEI")
    usd = fnum("GE_ETH_USD")
    voters = whole("GE_VOTERS", 1000)
    ballots = whole("GE_BALLOTS", voters)
    hours = whole("GE_HOURS", 12)
    batches = whole("GE_BATCHES", None)
    groth16 = whole("GE_GROTH16_EXTRA_GAS", 0)
    guardians = whole("GE_GUARDIANS", 3)
    threshold = whole("GE_THRESHOLD", (guardians // 2) + 1)
    options = whole("GE_OPTIONS", 2)
    if not 1 <= threshold <= guardians:
        sys.exit("error: THRESHOLD must be between 1 and GUARDIANS")
    if options < 2:
        sys.exit("error: OPTIONS must be at least 2")
    ops_filter = env("GE_OPS_FILTER")
    status = 0

    print("zk-voting gas economics (ZkVotingRollup)")
    print("========================================")
    print(f"L1 node:     {env('GE_L1_DESC', 'n/a')}")
    if l1_gwei is not None:
        extra = f" (base fee {l1_base:.3f} gwei)" if l1_base is not None else ""
        print(f"L1 gas:      {l1_gwei:.3f} gwei{extra}  [{env('GE_L1_GAS_SRC')}]")
    else:
        print(f"L1 gas:      n/a (dollars below use {REF_GWEI:g} gwei)")
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
    total_gas = 0
    for name in sorted(arts):
        a = arts[name]
        layer = "test" if name in TEST_ONLY else "token" if name in OPTIONAL else "L1"
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
        if layer == "L1":
            total_gas += gas
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
    eth, dollars = cost(total_gas, l1_gwei, usd)
    print(f"Sum of L1 rows: {fmt_int(total_gas)} gas = {fmt_eth(eth)} ETH {fmt_usd(dollars)}. "
          "Deployed once per chain and shared by every jurisdiction. Test-only and token rows are left out.")
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
        rule("Per-call gas (forge test --gas-report, median, without the 21,000 intrinsic gas)")
        print(f"{'contract.function':<44} {'median':>10} {'max':>10} {'calls':>6} {'ETH':>10} {'USD':>10}  when")
        for c, f, when in KEY_OPS:
            st = ops.get((c, f))
            if st is None:
                continue
            eth, dollars = cost(st.get("median"), l1_gwei, usd)
            print(f"{c + '.' + f:<44} {fmt_int(st.get('median')):>10} {fmt_int(st.get('max')):>10} "
                  f"{st.get('calls', 0):>6} {fmt_eth(eth):>10} {fmt_usd(dollars):>10}  {when}")
        missing = [f"{c}.{f}" for c, f, _ in KEY_OPS if (c, f) not in ops]
        if missing:
            print("not exercised by the selected tests: " + ", ".join(missing))
        if ops_filter:
            rx = re.compile(ops_filter)
            rule(f"All measured functions matching /{ops_filter}/")
            for (c, f), st in sorted(ops.items()):
                if rx.search(f"{c}.{f}"):
                    print(f"{c + '.' + f:<52} median {fmt_int(st.get('median')):>10}  max {fmt_int(st.get('max')):>10}  calls {st.get('calls', 0)}")

    print_scenarios(ops, voters, ballots, hours, batches, groth16, guardians, threshold, options, l1_gwei, usd, total_gas)
    return status


if __name__ == "__main__":
    sys.exit(main())
