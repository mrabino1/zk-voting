// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionIdentity} from "../ElectionIdentity.sol";
import {ElectionParams} from "../interfaces/ElectionParams.sol";
import {IElection} from "../interfaces/IElection.sol";
import {IElectionFactory} from "../interfaces/IElectionFactory.sol";
import {IL1TallyMirror} from "../interfaces/IL1TallyMirror.sol";
import {ISettledRoots} from "../interfaces/ISettledRoots.sol";

/// @title L1TallyMirror
/// @notice Court-grade copy of an L2 tally hash. Individual ballots are not posted.
/// @dev L1 slots are `(factory, electionId, jurisdictionId)`, not a public UUID
///      and not a bare uint256. A nefarious jurisdiction that copies another
///      body's UUID, or deploys its own factory with the same `electionId`,
///      cannot occupy the honest certification.
contract L1TallyMirror is IL1TallyMirror {
    /// @notice Audit M-05: window in which the admin may supersede a posted
    ///         certification. After it, the certification is final.
    uint256 public constant DISPUTE_WINDOW = 7 days;

    address public admin;
    /// @notice Optional `RollupSettlement`. When set, every post must cite an
    ///         L2 state root that settlement has accepted (audit M-05).
    address public settlement;
    /// @notice Block time each identity certification was (last) written.
    mapping(bytes32 => uint256) public postedAt;
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

    /// @notice Pin the shared ElectionFactory. First non-zero write wins;
    ///         unpinning would revive global `publishers[]` against every body.
    function setL2Factory(address factory_) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (factory_ == address(0)) revert ZeroAddress();
        if (l2Factory != address(0) && l2Factory != factory_) revert FactoryAlreadyPinned();
        l2Factory = factory_;
    }

    /// @notice Audit M-05: pin the rollup settlement contract (set once).
    function setSettlement(address settlement_) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (settlement_ == address(0)) revert ZeroAddress();
        if (settlement != address(0)) revert SettlementAlreadySet();
        settlement = settlement_;
        emit SettlementSet(settlement_);
    }

    /// @notice Audit M-05: governance correction inside the dispute window.
    ///         Admin only; the old hash, new values and a reason hash (e.g. of
    ///         the court order or incident report) are logged. The window is
    ///         not restarted, so a certification cannot be kept open forever.
    function supersedeCertifiedResult(
        bytes32 certificationId,
        bytes32 resultHash,
        uint256 totalBallots,
        bytes32 l2StateRoot,
        bytes32 reasonHash
    ) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (resultHash == bytes32(0)) revert ZeroResultHash();
        CertifiedResult storage c = certificationOf[certificationId];
        if (c.resultHash == bytes32(0)) revert NotPosted();
        if (block.timestamp >= postedAt[certificationId] + DISPUTE_WINDOW) revert DisputeWindowClosed();
        _requireSettled(l2StateRoot);
        bytes32 previous = c.resultHash;
        c.resultHash = resultHash;
        c.totalBallots = totalBallots;
        c.l2StateRoot = l2StateRoot;
        emit CertificationSuperseded(certificationId, previous, resultHash, totalBallots, l2StateRoot, reasonHash);
    }

    /// @notice True once a certification exists and its dispute window ended.
    function isFinal(bytes32 certificationId) external view returns (bool) {
        if (certificationOf[certificationId].resultHash == bytes32(0)) return false;
        return block.timestamp >= postedAt[certificationId] + DISPUTE_WINDOW;
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
        _requireSettled(l2StateRoot);
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
            postedAt[id] = block.timestamp;
        }
    }

    /// @notice Court-grade post keyed by factory + uint256 + jurisdiction.
    ///         `publicIdHash` is an attribute (the advertised UUID), not the slot.
    function postCertifiedResult(Certification calldata cert) external {
        if (cert.resultHash == bytes32(0)) revert ZeroResultHash();
        if (cert.factory == address(0)) revert ZeroFactory();
        if (cert.jurisdictionId == bytes32(0)) revert ZeroJurisdiction();
        if (l2Factory != address(0) && cert.factory != l2Factory) revert WrongFactory();
        _requireSettled(cert.l2StateRoot);

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
        postedAt[id] = block.timestamp;
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

    /// @dev Admin is break-glass. After `setL2Factory`, a global publisher
    ///      cannot certify an arbitrary jurisdiction — that is how one
    ///      compromised L1 key would overwrite every body. Unpinned mirrors
    ///      keep `publishers[]` for legacy tests and scripts.
    function _canPost(bytes32 jurisdictionId, address tallyOperator) internal view returns (bool) {
        if (msg.sender == admin) return true;
        if (jurisdictionPublisher[jurisdictionId][msg.sender]) return true;
        if (tallyOperator != address(0) && msg.sender == tallyOperator) return true;
        if (l2Factory == address(0) && publishers[msg.sender]) return true;
        return false;
    }

    function _requireSettled(bytes32 l2StateRoot) internal view {
        address s = settlement;
        if (s == address(0)) return;
        if (!ISettledRoots(s).isSettledRoot(l2StateRoot)) revert UnsettledStateRoot();
    }

    function _canReadFactory(address factory) internal view returns (bool) {
        return factory.code.length > 0;
    }
}
