// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface IRollupSettlement {
    error ZeroAddress();
    error NotAuthorized();
    error BadBatchIndex();
    error PrevRootMismatch();
    error DataHashMismatch();
    error InvalidProof();
    error GenesisAlreadySet();
    error VerifierRequired();
    error UnsupportedRole();

    event BatchSubmitted(uint64 indexed batchIndex, bytes32 newStateRoot, bytes32 dataHash, uint256 l1Block);
    event GenesisSet(bytes32 stateRoot);
    event SequencerSet(address indexed sequencer);
    event ProverSet(address indexed prover);

    struct Batch {
        bytes32 prevStateRoot;
        bytes32 newStateRoot;
        bytes32 dataHash;
        uint256 l1Block;
        uint256 dataLength;
    }

    function SEQUENCER_ROLE() external view returns (bytes32);

    function PROVER_ROLE() external view returns (bytes32);

    function admin() external view returns (address);

    function sequencer() external view returns (address);

    function prover() external view returns (address);

    function batchVerifier() external view returns (address);

    function mockMode() external view returns (bool);

    function stateRoot() external view returns (bytes32);

    function batchCount() external view returns (uint64);

    /// @notice Every L2 state root this contract has settled.
    function isSettledRoot(bytes32 root) external view returns (bool);

    function grantRole(bytes32 role, address account) external;

    function setGenesis(bytes32 genesisRoot) external;

    function computeDataHash(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot)
        external
        pure
        returns (bytes32);

    function hashBatch(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot) external pure returns (bytes32);

    function submitBatch(
        uint64 batchIndex,
        bytes32 prevStateRoot,
        bytes32 newStateRoot,
        bytes32 dataHash,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external;

    function batchPublicInputs(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot, bytes32 dataHash)
        external
        pure
        returns (uint256[] memory input);

    function getBatch(uint64 batchIndex) external view returns (Batch memory);
}
