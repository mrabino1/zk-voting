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

EIP170 = 24576   # runtime bytecode cap
EIP3860 = 49152  # initcode cap
TIGHT = 0.90

# Contracts that settle on L1 (Ethereum). Everything else is the election
# stack, which runs on the civic L2 (or any EVM chain it is deployed to).
L1_CONTRACTS = {"RollupSettlement", "L1TallyMirror", "ZkVotingMailbox"}

# The calls that make up one election, in lifecycle order.
KEY_OPS = [
    ("L2", "JurisdictionRegistry", "createJurisdiction", "once per jurisdiction"),
    ("L2", "ElectionFactory", "createElection", "once per election"),
    ("L2", "PasskeyAccountFactory", "createAccount", "once per voter account"),
    ("L2", "VoterRegistry", "register", "per voter"),
    ("L2", "BallotInbox", "submitVote", "per ballot"),
    ("L2", "BallotInbox", "submitVoteWithClearance", "per ballot (clearance path)"),
    ("L2", "Tally", "submitTally", "once per election"),
    ("L2", "Tally", "submitOpenedTally", "once per election (opened)"),
    ("L1", "RollupSettlement", "submitBatch", "per settled batch"),
    ("L1", "L1TallyMirror", "postResult", "once per election"),
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


def main():
    out_dir = env("GE_OUT_DIR")
    sc_dir = env("GE_SC_DIR")
    l1_gwei = fnum("GE_L1_GWEI")
    l1_base = fnum("GE_L1_BASEFEE_GWEI")
    l2_gwei = fnum("GE_L2_GWEI")
    usd = fnum("GE_ETH_USD")
    voters = int(fnum("GE_VOTERS") or 1000)
    batches = int(fnum("GE_BATCHES") or 1)
    groth16 = int(fnum("GE_GROTH16_EXTRA_GAS") or 0)
    ops_filter = env("GE_OPS_FILTER")
    status = 0

    print("zk-voting gas economics")
    print("=======================")
    print(f"L1 node:     {env('GE_L1_DESC', 'n/a')}")
    if l1_gwei is not None:
        extra = f" (base fee {l1_base:.3f} gwei)" if l1_base is not None else ""
        print(f"L1 gas:      {l1_gwei:.3f} gwei{extra}  [{env('GE_L1_GAS_SRC')}]")
    else:
        print("L1 gas:      n/a")
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

    rule("Bytecode size vs EIP-170 (runtime 24,576 B) and EIP-3860 (initcode 49,152 B)")
    hdr = f"{'contract':<26} {'layer':<5} {'runtime B':>10} {'%170':>6} {'init B':>9} {'%3860':>6}  {'deploy gas':>12} {'L1 ETH':>10} {'L1 USD':>10}  flag"
    print(hdr)
    tight = []
    total_gas = {"L1": 0, "L2": 0}
    for name in sorted(arts, key=lambda n: (n not in L1_CONTRACTS, n)):
        a = arts[name]
        layer = "L1" if name in L1_CONTRACTS else "L2"
        p170 = a["runtime"] / EIP170
        p3860 = a["init"] / EIP3860
        flag = ""
        if a["runtime"] > EIP170 or a["init"] > EIP3860:
            flag = "OVER"
            status = 1
        elif p170 >= TIGHT or p3860 >= TIGHT:
            flag = "TIGHT"
        if flag:
            tight.append((name, flag))
        if name in rec_gas:
            gas, mark = rec_gas[name], ""
        else:
            gas, mark = estimate_deploy_gas(a["init"], a["runtime"]), "~"
        total_gas[layer] += gas
        eth, dollars = cost(gas, l1_gwei, usd)
        print(f"{name:<26} {layer:<5} {a['runtime']:>10,} {p170:>6.1%} {a['init']:>9,} {p3860:>6.1%}  "
              f"{mark + fmt_int(gas):>12} {fmt_eth(eth):>10} {fmt_usd(dollars):>10}  {flag}")
    print("(~ = size-based floor, not measured; L1 cost = gas x L1 gas price)")
    if libraries:
        print("Libraries (inlined, no deploy line): " + ", ".join(libraries))
    closest = sorted(arts.items(), key=lambda kv: kv[1]["runtime"], reverse=True)[:3]
    print("Closest to EIP-170: " + ", ".join(f"{n} {v['runtime'] / EIP170:.1%}" for n, v in closest))
    for n, f in tight:
        if f == "OVER":
            print(f"ERROR: {n} is over a size cap and cannot be deployed on Ethereum")
        else:
            print(f"WARNING: {n} is TIGHT (>= {TIGHT:.0%} of a size cap)")
    for layer in ("L1", "L2"):
        eth, dollars = cost(total_gas[layer], l1_gwei, usd)
        print(f"Sum of {layer} rows: {fmt_int(total_gas[layer])} gas = {fmt_eth(eth)} ETH {fmt_usd(dollars)} at L1 gas price"
              + (" (includes alternatives, e.g. both verifiers and hashers)" if layer == "L2" else ""))
    if rec and (rec.get("gas") or {}).get("total"):
        g = rec["gas"]
        eth, dollars = cost(g["total"], l1_gwei, usd)
        print(f"Recorded {rec.get('script', 'deploy')} run: {fmt_int(g['total'])} gas over "
              f"{len(g.get('transactions') or [])} txs = {fmt_eth(eth)} ETH {fmt_usd(dollars)} at L1 gas price")

    # Measured calls -------------------------------------------------------------
    ops = load_gas_report(env("GE_GAS_REPORT"))
    if not env("GE_GAS_REPORT"):
        print("\n(Per-call gas not measured. Add --measure to run forge test --gas-report.)")
        return status
    if not ops:
        print("\nwarning: forge gas report was empty or unreadable", file=sys.stderr)
        return status

    l2_price = l2_gwei if l2_gwei is not None else l1_gwei
    l2_label = "L2 gas price" if l2_gwei is not None else "L1 gas price (no L2 price given)"
    rule("Per-call gas (forge test --gas-report, median; tests use MockVerifier)")
    print(f"{'layer':<5} {'contract.function':<44} {'median':>10} {'max':>10} {'calls':>6} {'ETH':>10} {'USD':>10}  when")
    medians = {}
    for layer, c, f, when in KEY_OPS:
        st = ops.get((c, f))
        if st is None:
            continue
        medians[(c, f)] = st.get("median")
        gwei = l1_gwei if layer == "L1" else l2_price
        eth, dollars = cost(st.get("median"), gwei, usd)
        print(f"{layer:<5} {c + '.' + f:<44} {fmt_int(st.get('median')):>10} {fmt_int(st.get('max')):>10} "
              f"{st.get('calls', 0):>6} {fmt_eth(eth):>10} {fmt_usd(dollars):>10}  {when}")
    missing = [f"{c}.{f}" for _, c, f, _ in KEY_OPS if (c, f) not in ops]
    if missing:
        print("not exercised by the selected tests: " + ", ".join(missing))
    print(f"L1 rows priced at L1 gas price; L2 rows at {l2_label}.")

    if ops_filter:
        rx = re.compile(ops_filter)
        rule(f"All measured functions matching /{ops_filter}/")
        for (c, f), st in sorted(ops.items()):
            if rx.search(f"{c}.{f}"):
                print(f"{c + '.' + f:<52} median {fmt_int(st.get('median')):>10}  max {fmt_int(st.get('max')):>10}  calls {st.get('calls', 0)}")

    # Per-election model ---------------------------------------------------------
    def m(c, f):
        return medians.get((c, f)) or 0

    rule(f"Per-election model: {voters:,} voters, {batches:,} L1 batch(es)")
    l2_parts = [
        ("createElection", 1, m("ElectionFactory", "createElection")),
        ("register x voters", voters, m("VoterRegistry", "register")),
        ("submitVote x voters", voters, m("BallotInbox", "submitVote")),
        ("submitTally", 1, m("Tally", "submitTally")),
    ]
    l1_parts = [
        ("submitBatch x batches", batches, m("RollupSettlement", "submitBatch")),
        ("postResult", 1, m("L1TallyMirror", "postResult")),
    ]
    l2_total = sum(n * g for _, n, g in l2_parts)
    l1_total = sum(n * g for _, n, g in l1_parts)
    for label, parts, total, gwei in (("L2 election stack", l2_parts, l2_total, l2_price),
                                      ("L1 settlement", l1_parts, l1_total, l1_gwei)):
        print(f"{label}:")
        for name, n, g in parts:
            print(f"  {name:<24} {fmt_int(n * g):>16} gas")
        eth, dollars = cost(total, gwei, usd)
        print(f"  {'total':<24} {fmt_int(total):>16} gas = {fmt_eth(eth)} ETH {fmt_usd(dollars)}")
    if groth16:
        extra = voters * groth16
        eth, dollars = cost(l2_total + extra, l2_price, usd)
        print(f"With a real Groth16 verify (+{groth16:,} gas per ballot, GROTH16_EXTRA_GAS): "
              f"L2 total {fmt_int(l2_total + extra)} gas = {fmt_eth(eth)} ETH {fmt_usd(dollars)}")
    if voters:
        eth, dollars = cost(l2_total / voters, l2_price, usd)
        print(f"L2 gas per voter (register + vote, amortized): {fmt_int(l2_total / voters)} = {fmt_usd(dollars)}")
    print("Voters pay nothing. These figures size the operator's gas budget.")
    return status


if __name__ == "__main__":
    sys.exit(main())
