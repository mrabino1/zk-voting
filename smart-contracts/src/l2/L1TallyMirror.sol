// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionIdentity} from "../ElectionIdentity.sol";
import {ElectionParams} from "../interfaces/ElectionParams.sol";
import {IElection} from "../interfaces/IElection.sol";
import {IElectionFactory} from "../interfaces/IElectionFactory.sol";

/// @title L1TallyMirror
/// @notice Court-grade copy of an L2 tally hash. Individual ballots are not posted.
/// @dev L1 slots are `(factory, electionId, jurisdictionId)`, not a public UUID
///      and not a bare uint256. A nefarious jurisdiction that copies another
///      body's UUID, or deploys its own factory with the same `electionId`,
///      cannot occupy the honest certification.
contract L1TallyMirror {
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

    address public admin;
    address public related;
    /// @notice Pinned shared ElectionFactory. Zero = not pinned (legacy / tests).
    address public l2Factory;

    mapping(uint256 => bytes32) public resultHashOf;
    mapping(uint256 => uint256) public totalBallotsOf;
    mapping(uint256 => bytes32) public claimedStateRoot;
    mapping(address => bool) public publishers;
    mapping(bytes32 => mapping(address => bool)) public jurisdictionPublisher;
    mapping(bytes32 => CertifiedResult) public certificationOf;
    mapping(bytes32 => bytes32[]) private _certsByPublicId;

    constructor(address admin_, address related_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        related = related_;
        publishers[admin_] = true;
    }

    function setPublisher(address account, bool allowed) external {
        if (msg.sender != admin) revert NotAuthorized();
        publishers[account] = allowed;
    }

    function setJurisdictionPublisher(bytes32 jurisdictionId, address account, bool allowed) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (jurisdictionId == bytes32(0)) revert ZeroJurisdiction();
        if (account == address(0)) revert ZeroAddress();
        jurisdictionPublisher[jurisdictionId][account] = allowed;
    }

    function setL2Factory(address factory_) external {
        if (msg.sender != admin) revert NotAuthorized();
        l2Factory = factory_;
    }

    /// @notice Legacy uint256 slot. Prefer `postCertifiedResult` so two factories
    ///         (or two jurisdictions) with the same `electionId` do not collide.
    ///         When `l2Factory` is pinned this path is closed: a publisher must
    ///         not occupy the global uint256 map with a copied factory id.
    function postResult(uint256 electionId, bytes32 resultHash, uint256 totalBallots, bytes32 l2StateRoot) external {
        if (l2Factory != address(0)) revert UseIdentityPost();
        if (!publishers[msg.sender] && msg.sender != admin) revert NotAuthorized();
        if (resultHashOf[electionId] != bytes32(0)) revert AlreadyPosted();
        if (resultHash == bytes32(0)) revert ZeroResultHash();
        resultHashOf[electionId] = resultHash;
        totalBallotsOf[electionId] = totalBallots;
        claimedStateRoot[electionId] = l2StateRoot;
        emit ElectionCertified(electionId, resultHash, totalBallots, l2StateRoot);

        bytes32 id = ElectionIdentity.certificationId(l2Factory, electionId, bytes32(0));
        if (certificationOf[id].resultHash == bytes32(0)) {
            certificationOf[id] = CertifiedResult({
                resultHash: resultHash,
                totalBallots: totalBallots,
                l2StateRoot: l2StateRoot,
                factory: l2Factory,
                electionId: electionId,
                jurisdictionId: bytes32(0),
                election: address(0),
                publicIdHash: bytes32(0),
                ballotSpecHash: bytes32(0)
            });
        }
    }

    /// @notice Court-grade post keyed by factory + uint256 + jurisdiction.
    ///         `publicIdHash` is an attribute (the advertised UUID), not the slot.
    function postCertifiedResult(Certification calldata cert) external {
        if (cert.resultHash == bytes32(0)) revert ZeroResultHash();
        if (cert.factory == address(0)) revert ZeroFactory();
        if (cert.jurisdictionId == bytes32(0)) revert ZeroJurisdiction();
        if (l2Factory != address(0) && cert.factory != l2Factory) revert WrongFactory();

        address election = cert.election;
        address tallyOperator;
        if (_canReadFactory(cert.factory)) {
            address clone = IElectionFactory(cert.factory).getElection(cert.electionId);
            if (clone == address(0)) revert UnknownElection();
            if (election == address(0)) {
                election = clone;
            } else if (election != clone) {
                revert ElectionMismatch();
            }
            ElectionParams memory p = IElection(clone).params();
            if (p.jurisdictionId != cert.jurisdictionId) revert JurisdictionMismatch();
            if (cert.ballotSpecHash != bytes32(0) && p.ballotSpecHash != cert.ballotSpecHash) {
                revert BallotSpecMismatch();
            }
            tallyOperator = p.tallyOperator;
        }

        if (!_canPost(cert.jurisdictionId, tallyOperator)) revert NotAuthorized();

        bytes32 id = ElectionIdentity.certificationId(cert.factory, cert.electionId, cert.jurisdictionId);
        if (certificationOf[id].resultHash != bytes32(0)) revert AlreadyPosted();

        certificationOf[id] = CertifiedResult({
            resultHash: cert.resultHash,
            totalBallots: cert.totalBallots,
            l2StateRoot: cert.l2StateRoot,
            factory: cert.factory,
            electionId: cert.electionId,
            jurisdictionId: cert.jurisdictionId,
            election: election,
            publicIdHash: cert.publicIdHash,
            ballotSpecHash: cert.ballotSpecHash
        });
        if (cert.publicIdHash != bytes32(0)) {
            _certsByPublicId[cert.publicIdHash].push(id);
        }

        emit ElectionCertified(cert.electionId, cert.resultHash, cert.totalBallots, cert.l2StateRoot);
        emit ElectionIdentityCertified(
            id,
            cert.electionId,
            cert.jurisdictionId,
            cert.factory,
            election,
            cert.publicIdHash,
            cert.ballotSpecHash,
            cert.resultHash,
            cert.totalBallots,
            cert.l2StateRoot
        );
    }

    function certificationIdOf(address factory, uint256 electionId, bytes32 jurisdictionId)
        external
        pure
        returns (bytes32)
    {
        return ElectionIdentity.certificationId(factory, electionId, jurisdictionId);
    }

    function resultHashOfIdentity(bytes32 id) external view returns (bytes32) {
        return certificationOf[id].resultHash;
    }

    function certificationsOfPublicId(bytes32 publicIdHash_) external view returns (bytes32[] memory) {
        return _certsByPublicId[publicIdHash_];
    }

    function publicIdCollision(bytes32 publicIdHash_) external view returns (bool) {
        return _certsByPublicId[publicIdHash_].length > 1;
    }

    function _canPost(bytes32 jurisdictionId, address tallyOperator) internal view returns (bool) {
        if (msg.sender == admin) return true;
        if (publishers[msg.sender]) return true;
        if (jurisdictionPublisher[jurisdictionId][msg.sender]) return true;
        if (tallyOperator != address(0) && msg.sender == tallyOperator) return true;
        return false;
    }

    function _canReadFactory(address factory) internal view returns (bool) {
        return factory.code.length > 0;
    }
}
