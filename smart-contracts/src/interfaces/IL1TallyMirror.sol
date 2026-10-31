// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface IL1TallyMirror {
    error ZeroAddress();
    error NotAuthorized();
    error AlreadyPosted();
    error ZeroResultHash();
    error ZeroJurisdiction();
    error ZeroFactory();
    error WrongFactory();
    error UnknownElection();
    error ElectionMismatch();
    error JurisdictionMismatch();
    error BallotSpecMismatch();
    error UseIdentityPost();
    error FactoryAlreadyPinned();
    error SettlementAlreadySet();
    error UnsettledStateRoot();
    error NotPosted();
    error DisputeWindowClosed();
    /// @notice A VOTE election cannot publish a result hash before `cutoffTime`.
    error ResultsSealedUntilEnd(uint256 electionId);

    struct Certification {
        address factory;
        uint256 electionId;
        bytes32 jurisdictionId;
        address election;
        bytes32 publicIdHash;
        bytes32 ballotSpecHash;
        bytes32 resultHash;
        uint256 totalBallots;
        bytes32 l2StateRoot;
    }

    struct CertifiedResult {
        bytes32 resultHash;
        uint256 totalBallots;
        bytes32 l2StateRoot;
        address factory;
        uint256 electionId;
        bytes32 jurisdictionId;
        address election;
        bytes32 publicIdHash;
        bytes32 ballotSpecHash;
    }

    event ElectionCertified(uint256 indexed electionId, bytes32 resultHash, uint256 totalBallots, bytes32 l2StateRoot);
    event ElectionIdentityCertified(
        bytes32 indexed certificationId,
        uint256 indexed electionId,
        bytes32 indexed jurisdictionId,
        address factory,
        address election,
        bytes32 publicIdHash,
        bytes32 ballotSpecHash,
        bytes32 resultHash,
        uint256 totalBallots,
        bytes32 l2StateRoot
    );
    event SettlementSet(uint256 indexed electionId, address indexed settlement);
    event CertificationSuperseded(
        bytes32 indexed certificationId,
        bytes32 previousResultHash,
        bytes32 resultHash,
        uint256 totalBallots,
        bytes32 l2StateRoot,
        bytes32 reasonHash
    );

    /// @notice Audit M-05: window in which the admin may supersede a posted certification.
    function DISPUTE_WINDOW() external view returns (uint256);

    function admin() external view returns (address);

    function settlementOf(uint256 electionId) external view returns (address);

    function postedAt(bytes32 certificationId) external view returns (uint256);

    function related() external view returns (address);

    function l2Factory() external view returns (address);

    function resultHashOf(uint256 electionId) external view returns (bytes32);

    function totalBallotsOf(uint256 electionId) external view returns (uint256);

    function claimedStateRoot(uint256 electionId) external view returns (bytes32);

    function publishers(address account) external view returns (bool);

    function jurisdictionPublisher(bytes32 jurisdictionId, address account) external view returns (bool);

    function certificationOf(bytes32 certificationId)
        external
        view
        returns (
            bytes32 resultHash,
            uint256 totalBallots,
            bytes32 l2StateRoot,
            address factory,
            uint256 electionId,
            bytes32 jurisdictionId,
            address election,
            bytes32 publicIdHash,
            bytes32 ballotSpecHash
        );

    function setPublisher(address account, bool allowed) external;

    function setJurisdictionPublisher(bytes32 jurisdictionId, address account, bool allowed) external;

    function setL2Factory(address factory_) external;

    function setSettlement(uint256 electionId, address settlement_) external;

    function supersedeCertifiedResult(
        bytes32 certificationId,
        bytes32 resultHash,
        uint256 totalBallots,
        bytes32 l2StateRoot,
        bytes32 reasonHash
    ) external;

    function isFinal(bytes32 certificationId) external view returns (bool);

    function postResult(uint256 electionId, bytes32 resultHash, uint256 totalBallots, bytes32 l2StateRoot) external;

    function postCertifiedResult(Certification calldata cert) external;

    function certificationIdOf(address factory, uint256 electionId, bytes32 jurisdictionId)
        external
        pure
        returns (bytes32);

    function resultHashOfIdentity(bytes32 id) external view returns (bytes32);

    function certificationsOfPublicId(bytes32 publicIdHash_) external view returns (bytes32[] memory);

    function publicIdCollision(bytes32 publicIdHash_) external view returns (bool);
}
