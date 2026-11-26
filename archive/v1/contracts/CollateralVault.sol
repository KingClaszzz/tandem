// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AbstractCallback } from "./reactive-lib/base/AbstractCallback.sol";
import { IPayable } from "./reactive-lib/interfaces/IPayable.sol";

/// @notice Base Sepolia side. Holds collateral. Only TandemReactive, through Base's callback proxy,
/// can release or seize it. Both callbacks are idempotent (act only on Locked loans).
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
    event CollateralSeized(uint256 indexed loanId, address indexed owner, uint256 seized, uint256 returned);

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
        if (amount == 0 || borrowAmount == 0 || amount > type(uint128).max) revert ZeroAmount();
        loanId = ++nextId;
        loans[loanId] = Loan(msg.sender, uint128(amount), Status.Locked);
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        emit CollateralLocked(loanId, msg.sender, amount, borrowAmount);
    }

    /// @dev Callback: the loan was repaid, or the borrow was refused or rejected.
    function release(address sender, uint256 loanId) external onlyServiceProvider onlyCallbackSender(sender) {
        Loan storage l = loans[loanId];
        if (l.status != Status.Locked) return;
        l.status = Status.Released;
        collateralToken.safeTransfer(l.owner, l.collateral);
        emit CollateralReleased(loanId, l.owner, l.collateral);
    }

    /// @dev Callback: the loan was liquidated on the debt chain. `amount` (debt + penalty, priced by
    /// the reactive contract) goes to the treasury; the rest goes back to the borrower.
    function seize(address sender, uint256 loanId, uint256 amount) external onlyServiceProvider onlyCallbackSender(sender) {
        Loan storage l = loans[loanId];
        if (l.status != Status.Locked) return;
        l.status = Status.Seized;
        uint256 seized = amount < l.collateral ? amount : l.collateral;
        uint256 returned = l.collateral - seized;
        if (seized > 0) collateralToken.safeTransfer(treasury, seized);
        if (returned > 0) collateralToken.safeTransfer(l.owner, returned);
        emit CollateralSeized(loanId, l.owner, seized, returned);
    }

    /// @notice Pays any outstanding callback debt from this contract's ETH balance. Anyone may call.
    function coverDebt() external {
        _coverDebt();
    }
}
