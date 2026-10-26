// =============================================================================
// UNTRUSTED — local dev Groth16 verifier for Vote(20).
// No ceremony has been held. The powers-of-tau entropy is public.
// Do not use this verifying key for a binding election.
// HASH_SCHEME=zk-voting.hash.poseidon-bn254-x5-t3-v1
// =============================================================================
// LOCAL UNTRUSTED SETUP — not a ceremony. Do not use for a binding election.
// HASH_SCHEME=zk-voting.hash.poseidon-bn254-x5-t3-v1
// circuit=vote
// Committed UNTRUSTED Vote(20) dev verifier. Not a ceremony. The proving zkey is not committed.
// NOT FOR PROFIT — civic public good, not a commercial product.
// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract UntrustedVote20Verifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 10138396652669819253866756416705702289099584486138031379402504964208482405464;
    uint256 constant alphay  = 5437684575239446665921271757541771640779419913774154249524608538567697453243;
    uint256 constant betax1  = 4621591147525408203906567585779231814255501128470260208435816519289684724775;
    uint256 constant betax2  = 12891514414876337225082870521565050840729692762139483588547251752580437821507;
    uint256 constant betay1  = 13211036706218325478515630873808897631224629643772703446668765524025468273848;
    uint256 constant betay2  = 16106100957741848898338087423108476663052285082323023584092516759518354775964;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 12933179725996318129177839436934052514651545191278441000332141528980594547363;
    uint256 constant deltax2 = 17241172289324238964532194195024335616419554972535457503477848663112389140275;
    uint256 constant deltay1 = 10908317802218235729353827581412336319130398139337568641284431964539536980039;
    uint256 constant deltay2 = 8971519553325379077098252990549421673703951563441404703870217954261463450608;

    
    uint256 constant IC0x = 14118641022355224584016902945760480672240330178236218313584315175043735214271;
    uint256 constant IC0y = 8831203681586440442670878524763274793169513950234961732142821197090939981299;
    
    uint256 constant IC1x = 13235545327615899066288243903565322935304257515250260099844241504180903674556;
    uint256 constant IC1y = 15867503242852827316479271254531266185090225173291452523629357188094659893739;
    
    uint256 constant IC2x = 7576276195522532247288759895009946087057738655547816933243039550921542043392;
    uint256 constant IC2y = 4302438369191630509631717931831180583550768719036378499220135915450716892358;
    
    uint256 constant IC3x = 9114951816326893477200571219566579102234356957409377273975426713836918103736;
    uint256 constant IC3y = 11630189442477216300698889738711531962458972180411677810869985647208688870447;
    
    uint256 constant IC4x = 13488833370369550419888011014097496165985953803871043706435816959196459768820;
    uint256 constant IC4y = 1272968227236950633796875247904409464372341541300406626652002489215878039883;
    
    uint256 constant IC5x = 10478660267590643206869345155118597411515172876889884804477350744663934847069;
    uint256 constant IC5y = 14306650840052315129914193568255021247371444133215928965820356041570125567056;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[5] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
