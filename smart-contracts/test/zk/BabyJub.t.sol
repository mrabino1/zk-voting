// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {BabyJub} from "../../src/zk/BabyJub.sol";
import {IndexedRoot} from "../../src/zk/IndexedRoot.sol";

contract BabyJubTest is Test {
    function testGeneratorAndOrder() public pure {
        (uint256 x, uint256 y) = BabyJub.mulBase(1);
        assertEq(x, BabyJub.GX);
        assertEq(y, BabyJub.GY);
        (x, y) = BabyJub.mulBase(2);
        assertEq(x, 10031262171927540148667355526369034398030886437092045105752248699557385197826);
        assertEq(y, 633281375905621697187330766174974863687049529291089048651929454608812697683);
        (x, y) = BabyJub.mulBase(BabyJub.ORDER);
        assertEq(x, 0);
        assertEq(y, 1);
        (uint256 x5, uint256 y5) = BabyJub.mulBase(5);
        assertEq(x5, 11480966271046430430613841218147196773252373073876138147006741179837832100836);
        assertEq(y5, 15148236048131954717802795400425086368006776860859772698778589175317365693546);
        assertTrue(BabyJub.onCurve(x5, y5));
        assertTrue(BabyJub.validPoint(x5, y5));
        assertFalse(BabyJub.onCurve(0, 0));
        assertTrue(BabyJub.validPoint(0, 0));
    }

    function testAddMatchesScalar() public pure {
        (uint256 x2, uint256 y2) = BabyJub.mulBase(2);
        (uint256 x3, uint256 y3) = BabyJub.mulBase(3);
        (uint256 x, uint256 y) = BabyJub.add(x2, y2, x3, y3);
        (uint256 x5, uint256 y5) = BabyJub.mulBase(5);
        assertEq(x, x5);
        assertEq(y, y5);
    }

    function testAddMatchesDouble() public pure {
        (uint256 x, uint256 y) = BabyJub.add(BabyJub.GX, BabyJub.GY, BabyJub.GX, BabyJub.GY);
        (uint256 mx, uint256 my) = BabyJub.mulBase(2);
        assertEq(x, mx);
        assertEq(y, my);
        (uint256 sx, uint256 sy) = BabyJub.sub(x, y, BabyJub.GX, BabyJub.GY);
        assertEq(sx, BabyJub.GX);
        assertEq(sy, BabyJub.GY);
    }

    function testEmptyRootConstant() public pure {
        assertEq(IndexedRoot.empty(20), IndexedRoot.fold(20));
    }

    function testScalarMulGas() public {
        uint256 before = gasleft();
        BabyJub.mulBase(5);
        uint256 one = before - gasleft();
        console2.log("babyjub-mul-1", one);
        before = gasleft();
        for (uint256 i; i < 16; ++i) {
            BabyJub.mulBase(i + 3);
        }
        uint256 sixteen = before - gasleft();
        console2.log("babyjub-mul-16", sixteen);
        assertLt(one, 200_000);
    }
}
