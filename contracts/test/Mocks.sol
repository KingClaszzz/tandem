// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IReactive } from "../reactive-lib/interfaces/IReactive.sol";
import { ISystemContract } from "../reactive-lib/interfaces/ISystemContract.sol";

/// @dev Test stand-in for Reactive's system contract. Its code is placed at 0x8888…8888.
contract MockSystem {
    struct Sub { uint256 chainId; address target; uint256 topic0; }

    Sub[] public subs;

    event Subscribed(address indexed rc, uint256 chainId, address target, uint256 topic0);
    event CallbackRequested(address indexed rc, uint256 chainId, address recipient, uint64 gasLimit, bytes payload);

    receive() external payable {}

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    function subscribe(uint256 chainId, address target, uint256 topic0, uint256, uint256, uint256) external {
        subs.push(Sub(chainId, target, topic0));
        emit Subscribed(msg.sender, chainId, target, topic0);
    }

    function subCount() external view returns (uint256) {
        return subs.length;
    }

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory c) external {
        emit CallbackRequested(msg.sender, c.chainId, c.recipient, c.gasLimit, c.payload);
    }

    /// @dev Delivers a log to a reactive contract as the system contract would.
    function deliver(address rc, IReactive.LogRecord calldata log) external {
        IReactive(payable(rc)).react(log);
    }
}

/// @dev Test stand-in for a destination chain's callback proxy.
contract MockProxy {
    receive() external payable {}

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    /// @dev Overwrites the payload's first argument with the reactive contract's address, then calls.
    function execute(address target, address rc, bytes memory payload) external {
        assembly {
            mstore(add(payload, 36), rc)
        }
        (bool ok, bytes memory ret) = target.call(payload);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
