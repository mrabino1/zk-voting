// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Optional ERC-20 with OpenZeppelin-style checkpoints (ERC20Votes).
// Civic elections do not call this contract. It has no governor, no spell,
// and no role that can move anyone else's tokens. ZK-Voting does not sell it.
//
// Clock is the Ethereum block number. A token poll snapshots that number on
// Ethereum mainnet. Timestamp clocks are intentionally unsupported.
//
// Voting power is zero until the holder delegates, including to themselves.
// That is the ERC20Votes rule: a balance that has never delegated is not
// counted. delegate() is the transaction that costs gas. A poll ballot is
// an off-chain signature and is not a function here.

/// @notice Minimal ERC-20 surface the wrapper and the token both expose.
interface ISignalUnderlying {
    function decimals() external view returns (uint8);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title SignalVotes
/// @notice ERC-20 + permit + block-number checkpoints. No owner and no mint hook.
/// @dev Permit and delegateBySig share one nonce per address, matching ERC20Votes.
abstract contract SignalVotes {
    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientAllowance();
    error ExpiredSignature(uint256 expiry);
    error InvalidNonce();
    error BadSignature();
    error WeightOverflow();
    error FutureLookup(uint256 timepoint);
    error TransferFailed();
    error Reentered();

    uint256 internal constant _SECP256K1_HALF =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 internal constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant _DELEGATION_TYPEHASH =
        keccak256("Delegation(address delegatee,uint256 nonce,uint256 expiry)");
    bytes32 internal constant _PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    struct Checkpoint {
        uint48 fromBlock;
        uint208 votes;
    }

    string public name;
    string public symbol;
    uint8 public decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;
    mapping(address => address) private _delegates;
    mapping(address => Checkpoint[]) private _voteCkpts;
    Checkpoint[] private _supplyCkpts;

    uint256 private _entered;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate);
    event DelegateVotesChanged(address indexed delegate, uint256 previousBalance, uint256 newBalance);

    modifier nonReentrant() {
        if (_entered != 0) revert Reentered();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @notice Block-number clock. Snapshots are Ethereum block numbers, not timestamps.
    function clock() public view virtual returns (uint48) {
        return uint48(block.number);
    }

    /// @notice ERC-6372 clock id. `from=default` means `clock()` is `block.number`.
    function CLOCK_MODE() public view virtual returns (string memory) {
        return "mode=blocknumber&from=default";
    }

    /// @notice Who `account` has delegated to. Zero means the balance has no voting power.
    function delegates(address account) public view returns (address) {
        return _delegates[account];
    }

    /// @notice Current voting power, including tokens delegated in. Undelegated balances are not included.
    function getVotes(address account) public view returns (uint256) {
        return _latestVotes(account);
    }

    /// @notice Voting power at a past block. Reverts if `timepoint` is the current block or later.
    /// @dev A poll fixes this block once, after it is finalized, so a later delegation cannot change it.
    function getPastVotes(address account, uint256 timepoint) public view returns (uint256) {
        return _lookup(_voteCkpts[account], timepoint);
    }

    /// @notice Total token supply at a past block. This is supply, not the sum of delegated votes.
    function getPastTotalSupply(uint256 timepoint) public view returns (uint256) {
        return _lookup(_supplyCkpts, timepoint);
    }

    /// @notice Lend this account's current balance to `delegatee`. Pass address(0) to undelegate.
    /// @dev Self-delegation is how a holder activates their own tokens. This is the gas-paying call.
    function delegate(address delegatee) external {
        _delegate(msg.sender, delegatee);
    }

    /// @notice Gasless delegation. The holder signs; anyone may submit. One nonce is shared with permit.
    function delegateBySig(address delegatee, uint256 nonce, uint256 expiry, uint8 v, bytes32 r, bytes32 s)
        external
    {
        if (block.timestamp > expiry) revert ExpiredSignature(expiry);
        address signer = _recover(
            _hashTypedData(keccak256(abi.encode(_DELEGATION_TYPEHASH, delegatee, nonce, expiry))), v, r, s
        );
        if (nonce != nonces[signer]) revert InvalidNonce();
        nonces[signer] = nonce + 1;
        _delegate(signer, delegatee);
    }

    /// @notice EIP-2612 approval. Uses the same nonce sequence as `delegateBySig`.
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        if (block.timestamp > deadline) revert ExpiredSignature(deadline);
        uint256 nonce = nonces[owner];
        bytes32 structHash = keccak256(abi.encode(_PERMIT_TYPEHASH, owner, spender, value, nonce, deadline));
        address signer = _recover(_hashTypedData(structHash), v, r, s);
        if (signer != owner) revert BadSignature();
        nonces[owner] = nonce + 1;
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes("1")), block.chainid, address(this))
        );
    }

    function _setup(string memory name_, string memory symbol_, uint8 decimals_) internal {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function _mint(address to, uint256 value) internal {
        if (to == address(0)) revert ZeroAddress();
        _update(address(0), to, value);
    }

    function _burn(address from, uint256 value) internal {
        if (from == address(0)) revert ZeroAddress();
        _update(from, address(0), value);
    }

    function _transfer(address from, address to, uint256 value) internal {
        if (from == address(0) || to == address(0)) revert ZeroAddress();
        _update(from, to, value);
    }

    function _update(address from, address to, uint256 value) internal {
        if (from == address(0)) {
            totalSupply += value;
            _writeSupply(totalSupply);
        } else {
            uint256 bal = balanceOf[from];
            if (bal < value) revert InsufficientBalance();
            balanceOf[from] = bal - value;
        }
        if (to == address(0)) {
            totalSupply -= value;
            _writeSupply(totalSupply);
        } else {
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
        // Votes follow delegation, not the raw balance. A transfer into an
        // undelegated account does not create voting power.
        _moveVotingPower(_delegates[from], _delegates[to], value);
    }

    function _delegate(address account, address delegatee) internal {
        address old = _delegates[account];
        _delegates[account] = delegatee;
        emit DelegateChanged(account, old, delegatee);
        _moveVotingPower(old, delegatee, balanceOf[account]);
    }

    function _moveVotingPower(address from, address to, uint256 amount) internal {
        if (from == to || amount == 0) return;
        if (from != address(0)) {
            uint256 previous = _latestVotes(from);
            if (previous < amount) revert InsufficientBalance();
            uint256 next = previous - amount;
            _writeVotes(from, next);
            emit DelegateVotesChanged(from, previous, next);
        }
        if (to != address(0)) {
            uint256 previous = _latestVotes(to);
            uint256 next = previous + amount;
            _writeVotes(to, next);
            emit DelegateVotesChanged(to, previous, next);
        }
    }

    function _latestVotes(address account) internal view returns (uint256) {
        uint256 n = _voteCkpts[account].length;
        return n == 0 ? 0 : _voteCkpts[account][n - 1].votes;
    }

    function _writeVotes(address account, uint256 value) internal {
        _push(_voteCkpts[account], value);
    }

    function _writeSupply(uint256 value) internal {
        _push(_supplyCkpts, value);
    }

    function _push(Checkpoint[] storage ckpts, uint256 value) internal {
        if (value > type(uint208).max) revert WeightOverflow();
        uint48 key = clock();
        uint208 stored = uint208(value);
        uint256 n = ckpts.length;
        if (n > 0 && ckpts[n - 1].fromBlock == key) {
            ckpts[n - 1].votes = stored;
        } else {
            ckpts.push(Checkpoint({fromBlock: key, votes: stored}));
        }
    }

    function _lookup(Checkpoint[] storage ckpts, uint256 timepoint) internal view returns (uint256) {
        if (timepoint >= clock()) revert FutureLookup(timepoint);
        uint256 n = ckpts.length;
        if (n == 0 || ckpts[0].fromBlock > timepoint) return 0;
        uint256 low = 0;
        uint256 high = n;
        while (low < high) {
            uint256 mid = (low + high) >> 1;
            if (ckpts[mid].fromBlock > timepoint) high = mid;
            else low = mid + 1;
        }
        return ckpts[low - 1].votes;
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function _recover(bytes32 digest, uint8 v, bytes32 r, bytes32 s) internal pure returns (address) {
        if (uint256(s) > _SECP256K1_HALF) revert BadSignature();
        if (v != 27 && v != 28) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}
