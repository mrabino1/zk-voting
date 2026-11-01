"""Print address|ContractName|0xconstructorArgs for every contract a forge
broadcast created, including CREATE2 children of ZkVotingDeployer, by matching
each init code against the compiled artifacts in out/."""
import json
import os
import sys


def main(bfile, out):
    b = json.load(open(bfile))
    arts = {}
    for d in os.listdir(out):
        if not d.endswith(".sol") or d.endswith(".t.sol") or d.endswith(".s.sol"):
            continue
        for f in os.listdir(os.path.join(out, d)):
            try:
                a = json.load(open(os.path.join(out, d, f)))
            except Exception:
                continue
            code = ((a.get("bytecode") or {}).get("object") or "").lower()
            if len(code) > 4:
                arts[f[:-5]] = code
    items = []
    for tx in b.get("transactions") or []:
        inp = (tx.get("transaction") or {}).get("input") or ""
        if tx.get("contractAddress") and inp:
            items.append((tx["contractAddress"], inp))
        for c in tx.get("additionalContracts") or []:
            items.append((c.get("address"), c.get("initCode") or ""))
    seen = set()
    for addr, init in items:
        init = init.lower()
        best = None
        for name, code in arts.items():
            if init.startswith(code) and (best is None or len(code) > len(best[1])):
                best = (name, code)
        if best and addr and addr.lower() not in seen:
            seen.add(addr.lower())
            print(f"{addr}|{best[0]}|0x{init[len(best[1]):]}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
