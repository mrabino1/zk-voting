// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {PasskeyAccount} from "../../src/account/PasskeyAccount.sol";
import {UserOp} from "../../src/account/ZkVotingEntryPoint.sol";
import {WebAuthn} from "../../src/account/WebAuthn.sol";
import {Deployer} from "../helpers/Deployer.sol";
import {Fixtures} from "../helpers/Fixtures.sol";
import {P256PrecompileOracle} from "./P256PrecompileOracle.sol";

contract WebAuthnHarness {
    function verify(
        bytes memory authData,
        string memory clientDataJSON,
        uint256[2] memory rs,
        uint256 x,
        uint256 y,
        bytes32 challenge
    ) external view returns (bool) {
        return WebAuthn.verify(authData, clientDataJSON, rs, x, y, challenge);
    }

    function b64(bytes32 d) external pure returns (string memory) {
        return string(WebAuthn.base64Url(d));
    }
}

/// @notice Regression tests for audit findings C-01 and C-02 (2026-10-24).
///         Each `testC0x_*Exploit*` is the original PoC and must now fail to exploit.
contract CriticalRegressionsTest is Deployer {
    address internal attacker = makeAddr("attacker");
    WebAuthnHarness internal harness;
    uint256 internal constant P256_PK = 0xC0FFEE;
    uint256 internal pubX;
    uint256 internal pubY;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        harness = new WebAuthnHarness();
        (pubX, pubY) = vm.publicKeyP256(P256_PK);
    }

    // ---------------------------------------------------------------- helpers

    function _installOracle() internal returns (P256PrecompileOracle oracle) {
        P256PrecompileOracle impl = new P256PrecompileOracle();
        vm.etch(address(0x100), address(impl).code);
        oracle = P256PrecompileOracle(payable(address(0x100)));
    }

    function _authData(bytes1 flags) internal pure returns (bytes memory a) {
        a = new bytes(37);
        a[32] = flags;
    }

    function _clientData(bytes32 challenge) internal view returns (string memory) {
        return string.concat(
            '{"type":"webauthn.get","challenge":"', harness.b64(challenge), '","origin":"https://republic.example"}'
        );
    }

    /// @dev Real P-256 signature over the WebAuthn message; registered with the oracle.
    function _sign(bytes memory authData, string memory cdj, P256PrecompileOracle oracle)
        internal
        returns (uint256[2] memory rs)
    {
        bytes32 msgHash = sha256(bytes.concat(authData, sha256(bytes(cdj))));
        (bytes32 r, bytes32 s) = vm.signP256(P256_PK, msgHash);
        rs = [uint256(r), uint256(s)];
        if (address(oracle) != address(0)) {
            oracle.allow(abi.encodePacked(msgHash, r, s, bytes32(pubX), bytes32(pubY)));
        }
    }

    function _victim() internal returns (PasskeyAccount acct) {
        address a = accountFactory.createAccount(keccak256("cred"), pubX, pubY, bytes32(0));
        acct = PasskeyAccount(payable(a));
        vm.deal(a, 5 ether);
    }

    function _op(address sender, uint256 n, bytes memory sig) internal view returns (UserOp memory op) {
        op.sender = sender;
        op.nonce = n;
        op.callData = abi.encodeWithSelector(PasskeyAccount.execute.selector, attacker, 5 ether, "");
        op.callGasLimit = 500_000;
        op.verificationGasLimit = 500_000;
        op.signature = sig;
    }

    function _run(UserOp memory op) internal {
        UserOp[] memory ops = new UserOp[](1);
        ops[0] = op;
        entryPoint.handleOps(ops);
    }

    // ------------------------------------------------------------------ C-01

    function testC01_ExploitForgedWebAuthnNoLongerDrains() public {
        PasskeyAccount acct = _victim();
        uint256[2] memory rs = [uint256(1), uint256(1)];
        bytes memory sig = abi.encode(new bytes(37), string('{"challenge":"x"}'), rs);
        vm.prank(attacker);
        vm.expectRevert();
        _run(_op(address(acct), 0, sig));
        assertEq(attacker.balance, 0);
        assertEq(address(acct).balance, 5 ether);
    }

    function testC01_NoPrecompileFailsClosedEvenForGenuineSignature() public {
        // No code at 0x100: a genuine signature must still be rejected (no fallback).
        bytes32 ch = keccak256("op");
        bytes memory ad = _authData(0x05);
        string memory cdj = _clientData(ch);
        uint256[2] memory rs = _sign(ad, cdj, P256PrecompileOracle(payable(address(0))));
        assertFalse(harness.verify(ad, cdj, rs, pubX, pubY, ch));
    }

    function testC01_GenuineAssertionVerifies() public {
        P256PrecompileOracle oracle = _installOracle();
        bytes32 ch = keccak256("op");
        bytes memory ad = _authData(0x05);
        string memory cdj = _clientData(ch);
        uint256[2] memory rs = _sign(ad, cdj, oracle);
        assertTrue(harness.verify(ad, cdj, rs, pubX, pubY, ch));
    }

    function testC01_ReplayUnderDifferentChallengeRejected() public {
        P256PrecompileOracle oracle = _installOracle();
        bytes32 ch = keccak256("op");
        bytes memory ad = _authData(0x05);
        string memory cdj = _clientData(ch);
        uint256[2] memory rs = _sign(ad, cdj, oracle);
        assertFalse(harness.verify(ad, cdj, rs, pubX, pubY, keccak256("other-op")));
    }

    function testC01_MissingTypeOrUserPresenceRejected() public {
        P256PrecompileOracle oracle = _installOracle();
        bytes32 ch = keccak256("op");
        string memory noType = string.concat('{"type":"webauthn.create","challenge":"', harness.b64(ch), '"}');
        bytes memory ad = _authData(0x05);
        uint256[2] memory rs = _sign(ad, noType, oracle);
        assertFalse(harness.verify(ad, noType, rs, pubX, pubY, ch));

        bytes memory noUp = _authData(0x04);
        string memory cdj = _clientData(ch);
        rs = _sign(noUp, cdj, oracle);
        assertFalse(harness.verify(noUp, cdj, rs, pubX, pubY, ch));
    }

    function testC01_OutOfRangeScalarsRejected() public {
        _installOracle();
        bytes32 ch = keccak256("op");
        bytes memory ad = _authData(0x05);
        string memory cdj = _clientData(ch);
        uint256[2] memory rs = [WebAuthn.P256_N, uint256(1)];
        assertFalse(harness.verify(ad, cdj, rs, pubX, pubY, ch));
        rs = [uint256(1), WebAuthn.P256_N];
        assertFalse(harness.verify(ad, cdj, rs, pubX, pubY, ch));
    }

    function testC01_Base64UrlVectors() public view {
        assertEq(harness.b64(bytes32(0)), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        assertEq(harness.b64(bytes32(type(uint256).max)), "__________________________________________8");
        assertEq(harness.b64(sha256("republic")), "oc2UxKnA-jaN0raC-7mHjwMUcZ3rNoVJPq3nldg4jbQ");
    }

    function testC01_EndToEndPasskeyUserOp() public {
        P256PrecompileOracle oracle = _installOracle();
        PasskeyAccount acct = _victim();
        UserOp memory op = _op(address(acct), 0, "");
        op.callData = abi.encodeWithSelector(PasskeyAccount.execute.selector, makeAddr("payee"), 1 ether, "");
        bytes32 h = entryPoint.getUserOpHash(op);
        bytes memory ad = _authData(0x05);
        string memory cdj = _clientData(h);
        op.signature = abi.encode(ad, cdj, _sign(ad, cdj, oracle));
        _run(op);
        assertEq(makeAddr("payee").balance, 1 ether);
        assertEq(acct.nonce(), 1);
    }

    // ------------------------------------------------------------------ C-02

    function testC02_ExploitBackupSignerHijackRejected() public {
        PasskeyAccount acct = _victim();
        (, uint256 pk) = makeAddrAndKey("evil");
        UserOp memory op = _op(address(acct), 0, "");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, entryPoint.getUserOpHash(op));
        op.signature = abi.encodePacked(r, s, v);
        vm.expectRevert();
        _run(op);
        assertEq(acct.ethBackupSigner(), address(0));
        assertEq(attacker.balance, 0);
    }

    function testC02_FixedBackupSignerOnlyAcceptsThatKey() public {
        (address owner, uint256 ownerPk) = makeAddrAndKey("owner");
        (, uint256 evilPk) = makeAddrAndKey("evil");
        address a = accountFactory.createAccountWithBackupSigner(keccak256("cred2"), pubX, pubY, owner, bytes32(0));
        assertEq(a, accountFactory.getAddressWithBackupSigner(keccak256("cred2"), pubX, pubY, owner, bytes32(0)));
        PasskeyAccount acct = PasskeyAccount(payable(a));
        vm.deal(a, 5 ether);
        assertEq(acct.ethBackupSigner(), owner);

        UserOp memory op = _op(a, 0, "");
        bytes32 h = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(evilPk, h);
        op.signature = abi.encodePacked(r, s, v);
        vm.expectRevert();
        _run(op);

        // eth_sign-prefixed variant of the owner signature is not accepted either.
        (v, r, s) = vm.sign(ownerPk, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        op.signature = abi.encodePacked(r, s, v);
        vm.expectRevert();
        _run(op);

        (v, r, s) = vm.sign(ownerPk, h);
        op.signature = abi.encodePacked(r, s, v);
        _run(op);
        assertEq(attacker.balance, 5 ether);
    }

    function testC02_HighSRejected() public {
        (address owner, uint256 ownerPk) = makeAddrAndKey("owner");
        address a = accountFactory.createAccountWithBackupSigner(keccak256("cred3"), pubX, pubY, owner, bytes32(0));
        vm.deal(a, 5 ether);
        UserOp memory op = _op(a, 0, "");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, entryPoint.getUserOpHash(op));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        op.signature = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert();
        _run(op);
    }
}
