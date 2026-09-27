// =============================================================================
// UNTRUSTED — local dev Groth16 verifier for Vote(20).
// No ceremony has been held. The powers-of-tau entropy is public.
// Do not use this verifying key for a binding election.
// HASH_SCHEME=republic.hash.poseidon-bn254-x5-t3-v1
// =============================================================================
// LOCAL UNTRUSTED SETUP — not a ceremony. Do not use for a binding election.
// HASH_SCHEME=republic.hash.poseidon-bn254-x5-t3-v1
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
    uint256 constant alphax  = 15267046323059833010893167609055462691221578197517392087323618486345380726504;
    uint256 constant alphay  = 20351478198954850971093305958810930911145223162656132965763336539183217859969;
    uint256 constant betax1  = 16966568671980477377761800053652938021033228276194900486403516653365622622010;
    uint256 constant betax2  = 18925654971505466778175972022182992894982100265965950425127364950020479355628;
    uint256 constant betay1  = 18896322544983520839512371126236419607692546363342248662952383546982690312377;
    uint256 constant betay2  = 3318692151267889434963529585458532818220196468279943996559298110229703600597;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 15488671543510402115155162884976367388455043110021836981741735353421321142199;
    uint256 constant deltax2 = 20033621362140393392005759359937274044533578080393831054674055113246204089078;
    uint256 constant deltay1 = 7436850202841321514496537755529645528280093819030754094825078377077681151710;
    uint256 constant deltay2 = 20678311661561558224695693507577150077202831436297828770660428685388960917618;

    
    uint256 constant IC0x = 21126534577584773040032989041758176213238988134909732030082007387771607237232;
    uint256 constant IC0y = 9238477703546421256419235475731722061877899119070165293461760597511590917188;
    
    uint256 constant IC1x = 188575735643080734119320804572692915183730888163897033721839750569090149374;
    uint256 constant IC1y = 10686501004288046670536766070723494411166139331221305159006901681864613256354;
    
    uint256 constant IC2x = 17145141149206460718071449059076237545524149344333203883015094508822989757489;
    uint256 constant IC2y = 18426957733931460834285972860034039047883521393757727304566781207067620397883;
    
    uint256 constant IC3x = 1043187243074150555198834263630049515989454496330030731304384219150019362243;
    uint256 constant IC3y = 1685955578409459185454966952288872796103024508652161179833034709870978765457;
    
    uint256 constant IC4x = 8778250467025308349671785146729191708256251770115939150590496686303972116148;
    uint256 constant IC4y = 1806025621361998201305041369937310232332327570813663280091459912685469640120;
    
    uint256 constant IC5x = 7725213114884120300506908538342736090857402725456972379571456799513181256063;
    uint256 constant IC5y = 11894330712353452284200682264154056867354085451444183189492244763143141147089;
    
 
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
