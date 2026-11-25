// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Demo ETH/USD feed on Base Sepolia (8 decimals). Anyone can move the price inside
/// fixed bounds so judges can trigger a liquidation themselves. Not an oracle: see README.
contract PriceFeed {
    uint256 public constant MIN_PRICE = 100e8;
    uint256 public constant MAX_PRICE = 20_000e8;

    uint256 public price;
    uint256 public round;

    event PriceUpdated(uint256 indexed round, uint256 price, address indexed by);

    error OutOfBounds();

    constructor(uint256 initialPrice) {
        _set(initialPrice);
    }

    function setPrice(uint256 newPrice) external {
        _set(newPrice);
    }

    function _set(uint256 p) internal {
        if (p < MIN_PRICE || p > MAX_PRICE) revert OutOfBounds();
        price = p;
        emit PriceUpdated(++round, p, msg.sender);
    }
}
