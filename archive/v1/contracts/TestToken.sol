// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only token with a rate-limited public faucet.
contract TestToken is ERC20 {
    uint8 private immutable _dec;
    uint256 public immutable faucetAmount;
    mapping(address => uint256) public lastDrip;

    error TooSoon(uint256 nextAt);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 faucetAmount_, uint256 initialSupply)
        ERC20(name_, symbol_)
    {
        _dec = decimals_;
        faucetAmount = faucetAmount_;
        _mint(msg.sender, initialSupply);
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    /// @notice Anyone can take `faucetAmount` once per minute.
    function faucet() external {
        uint256 last = lastDrip[msg.sender];
        if (last != 0 && block.timestamp < last + 60) revert TooSoon(last + 60);
        lastDrip[msg.sender] = block.timestamp;
        _mint(msg.sender, faucetAmount);
    }
}
