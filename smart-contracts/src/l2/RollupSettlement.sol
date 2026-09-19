// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IGroth16Verifier} from "../interfaces/IGroth16Verifier.sol";

/// @title RollupSettlement
/// @notice L1 settlement for Republic L2 (app-specific ZK rollup). No token.
contract RollupSettlement {
    error ZeroAddress();
    error NotAuthorized();
    error BadBatchIndex();
    error PrevRootMismatch();
    error DataHashMismatch();
    error InvalidProof();
    error GenesisAlreadySet();

    event BatchSubmitted(uint64 indexed batchIndex, bytes32 newStateRoot, bytes32 dataHash, uint256 l1Block);
    event GenesisSet(bytes32 stateRoot);

    struct Batch {
        bytes32 prevStateRoot;
        bytes32 newStateRoot;
        bytes32 dataHash;
        uint256 l1Block;
        uint256 dataLength;
    }

    address public admin;
    address public sequencer;
    address public prover;
    address public batchVerifier;
    bool public mockMode;
    bytes32 public stateRoot;
    uint64 public batchCount;
    mapping(uint64 => Batch) private _batches;

    constructor(address admin_, address sequencer_, address prover_, address batchVerifier_, bool mockMode_) {
        if (admin_ == address(0) || sequencer_ == address(0) || prover_ == address(0)) revert ZeroAddress();
        admin = admin_;
        sequencer = sequencer_;
        prover = prover_;
        batchVerifier = batchVerifier_;
        mockMode = mockMode_;
    }

    modifier onlyOperator() {
        if (msg.sender != sequencer && msg.sender != prover && msg.sender != admin) revert NotAuthorized();
        _;
    }

    function grantRole(bytes32, address) external {
        if (msg.sender != admin) revert NotAuthorized();
    }

    function setGenesis(bytes32 genesisRoot) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (batchCount != 0) revert GenesisAlreadySet();
        stateRoot = genesisRoot;
        emit GenesisSet(genesisRoot);
    }

    function computeDataHash(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(batchIndex, prevStateRoot, newStateRoot));
    }

    function hashBatch(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot) external pure returns (bytes32) {
        return computeDataHash(batchIndex, prevStateRoot, newStateRoot);
    }

    function submitBatch(
        uint64 batchIndex,
        bytes32 prevStateRoot,
        bytes32 newStateRoot,
        bytes32 dataHash,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external onlyOperator {
        if (batchIndex != batchCount) revert BadBatchIndex();
        if (prevStateRoot != stateRoot) revert PrevRootMismatch();
        if (dataHash != computeDataHash(batchIndex, prevStateRoot, newStateRoot)) revert DataHashMismatch();

        if (!mockMode && batchVerifier != address(0)) {
            uint256[] memory input = new uint256[](4);
            input[0] = uint256(prevStateRoot);
            input[1] = uint256(newStateRoot);
            input[2] = uint256(dataHash);
            input[3] = uint256(batchIndex);
            if (!IGroth16Verifier(batchVerifier).verifyProof(a, b, c, input)) revert InvalidProof();
        }

        _batches[batchIndex] = Batch({
            prevStateRoot: prevStateRoot,
            newStateRoot: newStateRoot,
            dataHash: dataHash,
            l1Block: block.number,
            dataLength: 0
        });
        stateRoot = newStateRoot;
        unchecked {
            batchCount += 1;
        }
        emit BatchSubmitted(batchIndex, newStateRoot, dataHash, block.number);
    }

    function getBatch(uint64 batchIndex) external view returns (Batch memory) {
        return _batches[batchIndex];
    }
}
