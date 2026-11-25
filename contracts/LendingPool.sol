// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AbstractCallback } from "./reactive-lib/base/AbstractCallback.sol";
import { IPayable } from "./reactive-lib/interfaces/IPayable.sol";

/// @notice Unichain Sepolia side. Source of truth for loan state: once a loan is liquidated here,
/// it can no longer be repaid, so a borrower can never both repay and lose collateral.
contract LendingPool is AbstractCallback {
    using SafeERC20 for IERC20;

    enum Status { None, Active, Repaid, Liquidated }

    struct Loan {
        address borrower;
        uint128 debt;
        Status status;
    }

    IERC20 public immutable asset;
    mapping(uint256 => Loan) public loans;

    event Disbursed(uint256 indexed loanId, address indexed borrower, uint256 amount);
    event BorrowRejected(uint256 indexed loanId, address indexed borrower, uint256 amount);
    event Repaid(uint256 indexed loanId, address indexed payer, uint256 amount);
    event Liquidated(uint256 indexed loanId, address indexed borrower, uint256 debt);

    error NotActive();

    constructor(address callbackProxy, address reactiveContract, IERC20 asset_)
        payable
        AbstractCallback(IPayable(payable(callbackProxy)), reactiveContract)
    {
        asset = asset_;
    }

    /// @dev Callback: collateral is locked on the collateral chain and the LTV check passed.
    function disburse(address sender, uint256 loanId, address borrower, uint256 amount)
        external
        onlyServiceProvider
        onlyCallbackSender(sender)
    {
        if (loans[loanId].status != Status.None) return;
        if (asset.balanceOf(address(this)) < amount) {
            emit BorrowRejected(loanId, borrower, amount);
            return;
        }
        loans[loanId] = Loan(borrower, uint128(amount), Status.Active);
        asset.safeTransfer(borrower, amount);
        emit Disbursed(loanId, borrower, amount);
    }

    /// @notice Repay a loan in full (anyone may repay on the borrower's behalf).
    function repay(uint256 loanId) external {
        Loan storage l = loans[loanId];
        if (l.status != Status.Active) revert NotActive();
        l.status = Status.Repaid;
        asset.safeTransferFrom(msg.sender, address(this), l.debt);
        emit Repaid(loanId, msg.sender, l.debt);
    }

    /// @dev Callback: the collateral price fell below the liquidation threshold.
    function liquidate(address sender, uint256 loanId) external onlyServiceProvider onlyCallbackSender(sender) {
        Loan storage l = loans[loanId];
        if (l.status != Status.Active) return;
        l.status = Status.Liquidated;
        emit Liquidated(loanId, l.borrower, l.debt);
    }

    function coverDebt() external {
        _coverDebt();
    }
}
