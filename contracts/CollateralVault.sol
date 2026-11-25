// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AbstractCallback } from "./reactive-lib/base/AbstractCallback.sol";
import { IPayable } from "./reactive-lib/interfaces/IPayable.sol";

/// @notice Base Sepolia side. Holds collateral; only Tandem's reactive contract can release or seize it.
contract CollateralVault is AbstractCallback {
    using SafeERC20 for IERC20;

    enum Status { None, Locked, Released, Seized }

    struct Loan {
        address owner;
        uint128 collateral;
        Status status;
    }

    IERC20 public immutable collateralToken;
    address public immutable treasury;
    uint256 public nextId;
    mapping(uint256 => Loan) public loans;

    event CollateralLocked(uint256 indexed loanId, address indexed owner, uint256 collateral, uint256 borrowAmount);
    event CollateralReleased(uint256 indexed loanId, address indexed owner, uint256 collateral);
    event CollateralSeized(uint256 indexed loanId, address indexed owner, uint256 collateral);

    error ZeroAmount();

    constructor(address callbackProxy, address reactiveContract, IERC20 collateralToken_, address treasury_)
        payable
        AbstractCallback(IPayable(payable(callbackProxy)), reactiveContract)
    {
        collateralToken = collateralToken_;
        treasury = treasury_;
    }

    /// @notice Lock collateral and ask for `borrowAmount` of the loan asset on the debt chain.
    function lock(uint256 amount, uint256 borrowAmount) external returns (uint256 loanId) {
        if (amount == 0 || borrowAmount == 0) revert ZeroAmount();
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        loanId = ++nextId;
        loans[loanId] = Loan(msg.sender, uint128(amount), Status.Locked);
        emit CollateralLocked(loanId, msg.sender, amount, borrowAmount);
    }

    /// @dev Callback: loan repaid, or borrow refused. No-op if the loan is not locked.
    function release(address sender, uint256 loanId) external onlyServiceProvider onlyCallbackSender(sender) {
        Loan storage l = loans[loanId];
        if (l.status != Status.Locked) return;
        l.status = Status.Released;
        collateralToken.safeTransfer(l.owner, l.collateral);
        emit CollateralReleased(loanId, l.owner, l.collateral);
    }

    /// @dev Callback: the loan was liquidated on the debt chain.
    function seize(address sender, uint256 loanId) external onlyServiceProvider onlyCallbackSender(sender) {
        Loan storage l = loans[loanId];
        if (l.status != Status.Locked) return;
        l.status = Status.Seized;
        collateralToken.safeTransfer(treasury, l.collateral);
        emit CollateralSeized(loanId, l.owner, l.collateral);
    }

    /// @notice Pays any outstanding callback debt from this contract's ETH balance.
    function coverDebt() external {
        _coverDebt();
    }
}
