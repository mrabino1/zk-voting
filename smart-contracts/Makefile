# zk-voting smart contracts (Foundry)
# NOT FOR PROFIT — civic public good, not a commercial product.

.PHONY: help build test test-fuzz test-file gas fmt fmt-check clean anvil deploy-local deploy sizes

RPC_URL ?= http://127.0.0.1:8545

help:
	@echo "make build                Compile (via-ir)"
	@echo "make test                 Run every test"
	@echo "make test-fuzz            Fuzz tests with 1024 runs"
	@echo "make test-file f=<path>   Run one test file"
	@echo "make gas                  Gas report"
	@echo "make sizes                Contract sizes against EIP-170"
	@echo "make fmt | fmt-check      Format Solidity"
	@echo "make anvil                Start a local Anvil node"
	@echo "make deploy-local         Deploy to Anvil with the mock batch verifier"
	@echo "make deploy               Public deploy: GOVERNOR, BATCH_VK, PRIVATE_KEY, RPC_URL"

build:
	forge build

test:
	forge test

test-fuzz:
	forge test --match-path "test/fuzz/**" --fuzz-runs 1024

test-file:
	@[ -n "$(f)" ] || { echo "Usage: make test-file f=test/Results.t.sol"; exit 1; }
	forge test --match-path "$(f)" -vv

gas:
	forge test --gas-report

sizes:
	forge build --sizes

fmt:
	forge fmt

fmt-check:
	forge fmt --check

clean:
	forge clean

anvil:
	anvil

deploy-local:
	forge script script/DeployLocal.s.sol --rpc-url "$(RPC_URL)" --broadcast

deploy:
	@[ -n "$$PRIVATE_KEY" ] || { echo "Set PRIVATE_KEY." >&2; exit 1; }
	@[ -n "$$GOVERNOR" ] && [ -n "$$BATCH_VK" ] || { echo "Set GOVERNOR and BATCH_VK." >&2; exit 1; }
	forge script script/Deploy.s.sol --rpc-url "$(RPC_URL)" --private-key "$$PRIVATE_KEY" --broadcast
