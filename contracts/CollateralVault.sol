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

    // Limits are enforced here, at the origin, because a revert here costs Reactive nothing. A request refused
    // later by the reactive contract has already cost one paid reaction plus a paid release callback.
    uint256 public constant MIN_BORROW = 50e6; // tUSD, 6 dp
    uint256 public constant MAX_BORROW = 5_000e6;
    uint256 public constant MAX_LOCKED_PER_OWNER = 3;
    uint256 public constant MAX_LOCKED = 50;

    IERC20 public immutable collateralToken;
    address public immutable treasury;
    uint256 public nextId;
    uint256 public lockedTotal;
    mapping(address => uint256) public lockedBy;
    mapping(uint256 => Loan) public loans;

    event CollateralLocked(uint256 indexed loanId, address indexed owner, uint256 collateral, uint256 borrowAmount);
    event CollateralReleased(uint256 indexed loanId, address indexed owner, uint256 collateral);
    event CollateralSeized(uint256 indexed loanId, address indexed owner, uint256 seized, uint256 returned);

    error ZeroAmount();
    error BorrowOutOfRange(uint256 min, uint256 max);
    error TooManyLoans();

    constructor(address callbackProxy, address reactiveContract, IERC20 collateralToken_, address treasury_)
        payable
        AbstractCallback(IPayable(payable(callbackProxy)), reactiveContract)
    {
        collateralToken = collateralToken_;
        treasury = treasury_;
    }

    /// @notice Lock collateral and ask for `borrowAmount` of the loan asset on the debt chain.
    function lock(uint256 amount, uint256 borrowAmount) external returns (uint256 loanId) {
        if (amount == 0 || amount > type(uint128).max) revert ZeroAmount();
        if (borrowAmount < MIN_BORROW || borrowAmount > MAX_BORROW) revert BorrowOutOfRange(MIN_BORROW, MAX_BORROW);
        if (lockedBy[msg.sender] >= MAX_LOCKED_PER_OWNER || lockedTotal >= MAX_LOCKED) revert TooManyLoans();
        lockedBy[msg.sender]++;
        lockedTotal++;
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
        _unlock(l.owner);
        collateralToken.safeTransfer(l.owner, l.collateral);
        emit CollateralReleased(loanId, l.owner, l.collateral);
    }

    /// @dev Callback: the loan was liquidated on the debt chain. `amount` (debt + penalty, priced by
    /// the reactive contract) goes to the treasury; the rest goes back to the borrower.
    function seize(address sender, uint256 loanId, uint256 amount) external onlyServiceProvider onlyCallbackSender(sender) {
        Loan storage l = loans[loanId];
        if (l.status != Status.Locked) return;
        l.status = Status.Seized;
        _unlock(l.owner);
        uint256 seized = amount < l.collateral ? amount : l.collateral;
        uint256 returned = l.collateral - seized;
        if (seized > 0) collateralToken.safeTransfer(treasury, seized);
        if (returned > 0) collateralToken.safeTransfer(l.owner, returned);
        emit CollateralSeized(loanId, l.owner, seized, returned);
    }

    function _unlock(address owner_) internal {
        lockedBy[owner_]--;
        lockedTotal--;
    }

    /// @notice Pays any outstanding callback debt from this contract's ETH balance. Anyone may call.
    function coverDebt() external {
        _coverDebt();
    }
}
