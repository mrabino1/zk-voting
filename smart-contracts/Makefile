# zk-voting smart contracts — Foundry Makefile
# NOT FOR PROFIT — civic public good. Not a commercial product.
#
# Targets: install, build, unit/fuzz/invariant test split, local deploy,
# format, and help.

.ONESHELL:

.PHONY: all install build build-dev build-file doc test test-fuzz test-invariant \
	test-all test-file test-paymaster test-verbose test-fuzz-verbose test-gas \
	test-coverage test-match test-module clean format format-check analyze anvil \
	deploy-local deploy-l1 deploy-l2 create-election certify-l1 print-addresses \
	snapshot snapshot-diff security console update full pre-commit help

RPC_URL ?= http://127.0.0.1:8545
# PRIVATE_KEY comes from the environment only; there is no default here.
# deploy-local falls back to Anvil's public dev key (local-only, chain 31337)
# inside script/anvil_deploy.sh. Other deploy targets require PRIVATE_KEY.
VERBOSITY ?= -vv

# Default target
all: install build

help:
	@echo "zk-voting — Available Commands"
	@echo ""
	@echo "Setup & Build:"
	@echo "  make install        - Install Solidity dependencies (forge-std)"
	@echo "  make build          - Compile smart contracts (via-ir, as in foundry.toml)"
	@echo "  make build-dev      - Compile without forcing via-ir (faster iteration)"
	@echo "  make build-file f=<path> - Compile a specific file and its deps"
	@echo "  make clean          - Clean build artifacts"
	@echo "  make format         - Format Solidity with forge fmt"
	@echo "  make format-check   - Check Solidity formatting"
	@echo ""
	@echo "Testing:"
	@echo "  make test           - Unit tests (excludes test/fuzz and test/invariant)"
	@echo "  make test-fuzz      - Fuzz tests (test/fuzz, 256 runs)"
	@echo "  make test-invariant - Invariant tests (test/invariant)"
	@echo "  make test-all       - Unit + fuzz + invariant"
	@echo "  make test-file f=<path> - Run a specific test file"
	@echo "  make test-paymaster - ZkVotingPaymaster tests only"
	@echo "  make test-verbose   - Unit tests with -vvvv"
	@echo "  make test-gas       - Unit tests with gas reporting"
	@echo "  make test-coverage  - Coverage for unit tests"
	@echo "  make test-match mt=<name> - Match a test function name"
	@echo "  make test-module m=<dir>  - Match a test subdirectory (e.g. zk, hasher)"
	@echo ""
	@echo "Local node & deploy:"
	@echo "  make anvil          - Start a local Anvil node"
	@echo "  make deploy-local   - Deploy the ZK-Voting stack to Anvil (MockVerifier)"
	@echo "  make deploy-l2      - Deploy the election stack to an L2 RPC"
	@echo "  make deploy-l1      - Deploy L1 settlement / tally mirror / mailbox"
	@echo "  make create-election - Create one election (needs FACTORY, START, CUTOFF, TITLE)"
	@echo "  make certify-l1     - Post tally hash to L1TallyMirror (no-op if L1 env unset)"
	@echo "  make print-addresses - Print last deployed addresses"
	@echo ""
	@echo "Other:"
	@echo "  make snapshot       - Gas snapshot"
	@echo "  make snapshot-diff  - Compare gas snapshots"
	@echo "  make security       - Run slither / mythril if installed"
	@echo "  make full           - clean, install, build, test"
	@echo "  make pre-commit     - format-check + unit tests"
	@echo ""
	@echo "Variables:"
	@echo "  f=<path>            - File for test-file / build-file"
	@echo "  mt=<test>           - Test name for test-match"
	@echo "  m=<module>          - Subdir under test/ for test-module"
	@echo "  RPC_URL=...         - RPC (default: http://127.0.0.1:8545)"
	@echo "  PRIVATE_KEY=...     - Deployer key from env (required except deploy-local on Anvil)"
	@echo "  ZK_VOTING_PROVING_PATH=1 - Deploy VoteVerifier instead of MockVerifier"

install:
	@echo "Installing Solidity dependencies..."
	forge install foundry-rs/forge-std --no-commit
	@echo "Solidity dependencies installed!"

build:
	@echo "Building contracts (via-ir)..."
	forge build --via-ir
	@echo "Build complete!"

build-dev:
	@echo "Building contracts..."
	forge build
	@echo "Build complete!"

build-file:
	@if [ -z "$(f)" ]; then \
		echo "Usage: make build-file f=src/path/to/file.sol"; \
		exit 1; \
	fi
	@echo "Building specific file: $(f)"
	forge build --match-path "$(f)"
	@echo "Build complete!"

doc:
	@echo "Generating documentation..."
	forge doc
	@echo "Documentation generated!"

# Unit / integration only — skip fuzz + invariant .
test:
	@echo "Running unit and integration tests (excluding fuzz and invariant)..."
	forge test --via-ir --no-match-path "test/{fuzz,invariant}/**"

test-fuzz:
	@echo "Running fuzz tests (test/fuzz, 256 runs)..."
	forge test --via-ir --match-path "test/fuzz/**" --fuzz-runs 256

test-invariant:
	@echo "Running invariant tests (test/invariant)..."
	forge test --via-ir --match-path "test/invariant/**"

test-all: test test-fuzz test-invariant
	@echo "All tests (unit, fuzz, and invariant) completed!"

test-file:
	@if [ -z "$(f)" ]; then \
		echo "Usage: make test-file f=test/Tally.t.sol"; \
		exit 1; \
	fi
	@echo "Running test file: $(f)"
	forge test --via-ir --match-path "$(f)" -vv

test-paymaster:
	@echo "Running Paymaster tests..."
	forge test --via-ir --match-path "test/Paymaster.t.sol" -vv

test-verbose:
	@echo "Running unit tests with verbose output..."
	forge test --via-ir --no-match-path "test/{fuzz,invariant}/**" -vvvv

test-fuzz-verbose:
	@echo "Running fuzz tests with verbose output..."
	forge test --via-ir --match-path "test/fuzz/**" -vvvv --fuzz-runs 256

test-gas:
	@echo "Running unit tests with gas reporting..."
	forge test --via-ir --no-match-path "test/{fuzz,invariant}/**" --gas-report

test-coverage:
	@echo "Generating unit-test coverage report..."
	forge coverage --via-ir --no-match-path "test/{fuzz,invariant}/**"

test-match:
	@if [ -z "$(mt)" ]; then \
		echo "Usage: make test-match mt=test_SubmitVote"; \
		exit 1; \
	fi
	@echo "Running tests matching: $(mt)"
	forge test --via-ir --match-test $(mt) -vvv

test-module:
	@if [ -z "$(m)" ]; then \
		echo "Usage: make test-module m=<module>"; \
		echo "Example: make test-module m=zk"; \
		echo "         make test-module m=hasher"; \
		echo "         make test-module m=fuzz"; \
		exit 1; \
	fi
	@echo "Running tests for module: $(m)"
	forge test --via-ir --match-path "test/$(m)/**" -vv

clean:
	@echo "Cleaning build artifacts..."
	forge clean
	@echo "Clean complete!"

format:
	@echo "Formatting Solidity code..."
	forge fmt

format-check:
	@echo "Checking Solidity formatting..."
	forge fmt --check

analyze:
	@echo "Running static analysis..."
	@echo "Note: Install slither for advanced analysis"
	forge build --force --via-ir

anvil:
	@echo "Starting local Anvil node..."
	@echo "Default accounts each have 10,000 ETH"
	@echo "Account #0: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
	anvil

deploy-local:
	@echo "Deploying ZK-Voting stack to local Anvil (MockVerifier by default)..."
	@echo "Set ZK_VOTING_PROVING_PATH=1 to deploy VoteVerifier instead."
	@bash script/anvil_deploy.sh

deploy-l2:
	@[ -n "$$PRIVATE_KEY" ] || { echo "Set PRIVATE_KEY in the environment." >&2; exit 1; }
	@echo "Deploying election stack to L2 (RPC_URL=$(RPC_URL))..."
	forge script script/DeployL2.s.sol:DeployL2 \
		--rpc-url "$(RPC_URL)" \
		--private-key "$$PRIVATE_KEY" \
		--broadcast \
		-vvv

deploy-l1:
	@[ -n "$$PRIVATE_KEY" ] || { echo "Set PRIVATE_KEY in the environment." >&2; exit 1; }
	@echo "Deploying L1 settlement / tally mirror / mailbox (RPC_URL=$(RPC_URL))..."
	forge script script/DeployL1.s.sol:DeployL1 \
		--rpc-url "$(RPC_URL)" \
		--private-key "$$PRIVATE_KEY" \
		--broadcast \
		-vvv

create-election:
	@if [ -z "$(FACTORY)" ] || [ -z "$(START)" ] || [ -z "$(CUTOFF)" ] || [ -z "$(TITLE)" ]; then \
		echo "Usage: make create-election FACTORY=0x... START=<unix> CUTOFF=<unix> TITLE='Name'"; \
		exit 1; \
	fi
	@[ -n "$$PRIVATE_KEY" ] || { echo "Set PRIVATE_KEY in the environment." >&2; exit 1; }
	@echo "Creating election on $(FACTORY)..."
	FACTORY="$(FACTORY)" START="$(START)" CUTOFF="$(CUTOFF)" TITLE="$(TITLE)" \
		forge script script/CreateElection.s.sol:CreateElection \
		--rpc-url "$(RPC_URL)" \
		--private-key "$$PRIVATE_KEY" \
		--broadcast \
		-vvv

certify-l1:
	@echo "Certifying L1 tally hash (no-op if L1 env is unset)..."
	@bash script/certify_l1.sh

print-addresses:
	@echo "Printing deployed addresses..."
	forge script script/PrintAddresses.s.sol \
		--rpc-url "$(RPC_URL)" \
		-vvv

snapshot:
	@echo "Taking gas snapshot..."
	forge snapshot --via-ir

snapshot-diff:
	@echo "Comparing gas snapshots..."
	forge snapshot --via-ir --diff

security:
	@echo "Running security checks..."
	@command -v slither >/dev/null 2>&1 && slither . || echo "Install slither: pip3 install slither-analyzer"
	@command -v mythril >/dev/null 2>&1 && myth analyze src/ || echo "Install mythril: pip3 install mythril"

console:
	@echo "Starting Foundry console..."
	forge console

update:
	@echo "Updating dependencies..."
	forge update

full: clean install build test
	@echo "Full workflow complete!"

pre-commit: format-check test
	@echo "Pre-commit checks passed!"
