// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "../interfaces/ElectionParams.sol";
import {IElection} from "../interfaces/IElection.sol";
import {IElectionFactory} from "../interfaces/IElectionFactory.sol";

/// @title WesolowskiTimeLock
/// @notice Time-lock opening for a sealed vote. The output `y = x^(2^T) mod N`
///         is accepted only with a Wesolowski proof, and only at or after cutoff.
/// @dev Assumptions, also stated in `docs/sealed-vote-hold.md`:
///      - `N` is an odd composite whose prime factors were destroyed at setup.
///        Anyone who factors `N` can skip the sequential squarings.
///      - This verifier takes a modulus that fits in one EVM word (at most 256
///        bits). A 256-bit modulus is not a long-term production delay. A
///        production election must use a modulus whose factors are unknown to
///        every participant, including the operator, and a `T` that the fastest
///        assumed machine cannot finish before `cutoffTime`. Replacing this
///        verifier with a beacon verifier is a later deployment, not this one.
///      - The proof being valid does not by itself hide the tally key. The key
///        is split k-of-n. This opening is an extra gate the contract requires
///        before it will accept a share.
contract WesolowskiTimeLock {
    uint256 internal constant MAX_PRIME_STEPS = 512;

    IElectionFactory public immutable factory;

    struct Lock {
        uint256 n;
        uint256 x;
        uint256 t;
        uint256 y;
        bool configured;
        bool open;
    }

    mapping(uint256 => Lock) private _locks;

    error UnknownElection();
    error NotTallyOperator();
    error TooEarly(uint256 electionId);
    error ConfigureClosed();
    error AlreadyConfigured();
    error AlreadyOpen();
    error NotConfigured();
    error BadLock();
    error BadOpening();
    error NoPrime();

    event TimeLockConfigured(uint256 indexed electionId, uint256 n, uint256 x, uint256 t);
    event TimeLockOpened(uint256 indexed electionId, uint256 y);

    constructor(address factory_) {
        if (factory_ == address(0)) revert UnknownElection();
        factory = IElectionFactory(factory_);
    }

    /// @notice One-time puzzle. `n` odd and greater than `x`. Callable only
    ///         before the election starts. Does not record a ballot.
    function configure(uint256 electionId, uint256 n, uint256 x, uint256 t) external {
        if (_locks[electionId].configured) revert AlreadyConfigured();
        if (n < 3 || n % 2 == 0 || x < 2 || x >= n || t == 0 || t > 255) revert BadLock();
        ElectionParams memory p = _params(electionId);
        if (msg.sender != p.tallyOperator) revert NotTallyOperator();
        if (block.timestamp >= p.startTime) revert ConfigureClosed();
        _locks[electionId] = Lock({n: n, x: x, t: t, y: 0, configured: true, open: false});
        emit TimeLockConfigured(electionId, n, x, t);
    }

    /// @notice Store `y` once the proof checks. Reverts before cutoff, so an
    ///         early solution cannot be written here. Calldata of a reverted
    ///         transaction is still public: do not send this before cutoff.
    function submitOpening(uint256 electionId, uint256 y, uint256 pi) external {
        Lock storage lock = _locks[electionId];
        if (!lock.configured) revert NotConfigured();
        if (lock.open) revert AlreadyOpen();
        ElectionParams memory p = _params(electionId);
        if (block.timestamp < p.cutoffTime) revert TooEarly(electionId);
        if (y == 0 || y >= lock.n || pi >= lock.n) revert BadOpening();
        if (!_verify(lock.n, lock.x, y, lock.t, pi)) revert BadOpening();
        lock.y = y;
        lock.open = true;
        emit TimeLockOpened(electionId, y);
    }

    function isOpen(uint256 electionId) external view returns (bool) {
        return _locks[electionId].open;
    }

    function lockOf(uint256 electionId) external view returns (uint256 n, uint256 x, uint256 t, uint256 y, bool open) {
        Lock storage lock = _locks[electionId];
        return (lock.n, lock.x, lock.t, lock.y, lock.open);
    }

    /// @notice `2^T = q * l + r`, with `l` the challenge prime. Verifier checks
    ///         `pi^l * x^r ≡ y (mod n)`.
    function verify(uint256 n, uint256 x, uint256 y, uint256 t, uint256 pi) external pure returns (bool) {
        if (n < 3 || y >= n || pi >= n || x >= n) return false;
        return _verify(n, x, y, t, pi);
    }

    /// @notice Modular exponentiation for provers and tests. Not a decryption key.
    function expMod(uint256 base, uint256 exponent, uint256 modulus) external pure returns (uint256) {
        return _pow(base, exponent, modulus);
    }

    /// @notice Deterministic odd challenge derived from the statement. The
    ///         prime test is twelve Miller-Rabin rounds, not a general proof.
    function challenge(uint256 x, uint256 y, uint256 t) external pure returns (uint256) {
        return _challenge(x, y, t);
    }

    function _verify(uint256 n, uint256 x, uint256 y, uint256 t, uint256 pi) internal pure returns (bool) {
        uint256 l = _challenge(x, y, t);
        uint256 r = _pow(2, t, l);
        uint256 left = mulmod(_pow(pi, l, n), _pow(x, r, n), n);
        return left == y;
    }

    function _challenge(uint256 x, uint256 y, uint256 t) internal pure returns (uint256 l) {
        for (uint256 i; i < MAX_PRIME_STEPS; ++i) {
            l = uint256(keccak256(abi.encode(x, y, t, i)));
            l &= (uint256(1) << 128) - 1;
            l |= 1;
            if (l < 3) continue;
            if (_isPrime(l)) return l;
        }
        revert NoPrime();
    }

    function _isPrime(uint256 n) internal pure returns (bool) {
        if (n < 2) return false;
        if (n % 2 == 0) return n == 2;
        if (n < 9) return n != 1 && n != 4 && n != 6 && n != 8;
        uint256 d = n - 1;
        uint256 s;
        while (d % 2 == 0) {
            d /= 2;
            unchecked {
                ++s;
            }
        }
        if (!_miller(n, d, s, 2)) return false;
        if (!_miller(n, d, s, 3)) return false;
        if (!_miller(n, d, s, 5)) return false;
        if (!_miller(n, d, s, 7)) return false;
        if (!_miller(n, d, s, 11)) return false;
        if (!_miller(n, d, s, 13)) return false;
        if (!_miller(n, d, s, 17)) return false;
        if (!_miller(n, d, s, 19)) return false;
        if (!_miller(n, d, s, 23)) return false;
        if (!_miller(n, d, s, 29)) return false;
        if (!_miller(n, d, s, 31)) return false;
        if (!_miller(n, d, s, 37)) return false;
        return true;
    }

    function _miller(uint256 n, uint256 d, uint256 s, uint256 base) internal pure returns (bool) {
        if (base >= n) return true;
        uint256 x = _pow(base, d, n);
        if (x == 1 || x == n - 1) return true;
        for (uint256 i = 1; i < s; ++i) {
            x = mulmod(x, x, n);
            if (x == n - 1) return true;
        }
        return false;
    }

    function _pow(uint256 base, uint256 exponent, uint256 modulus) internal pure returns (uint256 result) {
        if (modulus == 0) revert BadLock();
        result = 1;
        base %= modulus;
        while (exponent != 0) {
            if (exponent & 1 == 1) result = mulmod(result, base, modulus);
            base = mulmod(base, base, modulus);
            exponent >>= 1;
        }
    }

    function _params(uint256 electionId) internal view returns (ElectionParams memory p) {
        address electionAddr = factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();
        p = IElection(electionAddr).params();
    }
}
