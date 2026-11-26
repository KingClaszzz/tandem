// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { AbstractReactive } from "./reactive-lib/base/AbstractReactive.sol";
import { ISystemContract } from "./reactive-lib/interfaces/ISystemContract.sol";

/// @title TandemReactive
/// @notice Runs on Reactive (Lasna). Mirrors every loan and the collateral price, and drives the
/// cross-chain lending loops. The state machine, ordering rules and threat model are in docs/DESIGN.md.
///   borrow:      CollateralLocked (Base)  -> disburse (Unichain)      | release (Base) if refused
///   repay:       Repaid (Unichain)        -> release (Base)
///   liquidation: AnswerUpdated (Base)     -> liquidate (Unichain) -> Liquidated -> seize (Base)
/// Every request is confirmed by an event from the destination before the loan is final, and any
/// stuck request can be re-sent by anyone through `poke` (callbacks are idempotent).
contract TandemReactive is AbstractReactive {
    // ---------------------------------------------------------------- parameters
    uint256 public constant MAX_LTV_BPS = 7_000;
    uint256 public constant LIQ_THRESHOLD_BPS = 8_000;
    uint256 public constant LIQ_PENALTY_BPS = 500;
    uint256 public constant MIN_DEBT = 50e6; // 50 tUSD
    uint256 public constant MAX_OPEN = 50;
    uint256 public constant MAX_OPEN_PER_BORROWER = 3;
    uint256 public constant MAX_LIQ_PER_SWEEP = 10;
    uint256 public constant RETRY_AFTER = 60; // seconds
    uint64 public constant CALLBACK_GAS = 400_000;

    // ---------------------------------------------------------------- origin event signatures
    uint256 private constant ANSWER_UPDATED = uint256(keccak256("AnswerUpdated(int256,uint256,uint256)"));
    uint256 private constant COLLATERAL_LOCKED = uint256(keccak256("CollateralLocked(uint256,address,uint256,uint256)"));
    uint256 private constant COLLATERAL_RELEASED = uint256(keccak256("CollateralReleased(uint256,address,uint256)"));
    uint256 private constant COLLATERAL_SEIZED = uint256(keccak256("CollateralSeized(uint256,address,uint256,uint256)"));
    uint256 private constant DISBURSED = uint256(keccak256("Disbursed(uint256,address,uint256)"));
    uint256 private constant BORROW_REJECTED = uint256(keccak256("BorrowRejected(uint256,address,uint256)"));
    uint256 private constant REPAID = uint256(keccak256("Repaid(uint256,address,uint256)"));
    uint256 private constant LIQUIDATED = uint256(keccak256("Liquidated(uint256,address,uint256)"));

    enum Status { None, Pending, Active, Liquidating, Seizing, Releasing, Released, Seized }

    struct Loan {
        address borrower;
        uint64 lastRequest; // timestamp of the last callback request (for poke)
        Status status;
        uint128 collateral; // tWETH, 18 dp
        uint128 debt; // tUSD, 6 dp
        uint128 seizeAmount; // tWETH to the treasury, fixed when liquidation is requested
    }

    address public immutable owner;
    uint256 public immutable collateralChainId;
    uint256 public immutable debtChainId;

    address public feed;
    address public vault;
    address public pool;
    uint256 public price; // USD, 8 dp
    uint256 public lastRound;

    mapping(uint256 => Loan) public loans;
    uint256 public openTotal; // Pending + Active + Liquidating
    mapping(address => uint256) public openBy;
    uint256[] public active; // Active + Liquidating, scanned on every price update
    mapping(uint256 => uint256) private activeIndex; // loanId => index + 1

    event Configured(address feed, address vault, address pool, uint256 price);
    event PriceSeen(uint256 indexed round, uint256 price);
    event BorrowApproved(uint256 indexed loanId, uint256 collateral, uint256 debt, uint256 price);
    event BorrowRefused(uint256 indexed loanId, uint8 reason);
    event LiquidationRequested(uint256 indexed loanId, uint256 debt, uint256 price, uint256 seizeAmount);
    event SeizeRequested(uint256 indexed loanId, uint256 seizeAmount);
    event ReleaseRequested(uint256 indexed loanId);
    event LoanFinal(uint256 indexed loanId, Status status);
    event Poked(uint256 indexed loanId, Status status);

    // BorrowRefused reasons
    uint8 public constant REFUSE_LTV = 1;
    uint8 public constant REFUSE_TOO_SMALL = 2;
    uint8 public constant REFUSE_FULL = 3;
    uint8 public constant REFUSE_BORROWER_LIMIT = 4;

    error NotOwner();
    error AlreadyConfigured();
    error NothingToRetry(Status status);
    error TooSoon(uint256 retryAt);

    constructor(uint256 collateralChainId_, uint256 debtChainId_) payable {
        owner = msg.sender;
        collateralChainId = collateralChainId_;
        debtChainId = debtChainId_;
    }

    /// @notice One-time wiring. The vault and pool need this contract's address as their only
    /// callback sender, so they are deployed after it. The owner has no other power.
    function configure(address feed_, address vault_, address pool_, uint256 initialPrice) external {
        if (msg.sender != owner) revert NotOwner();
        if (feed != address(0)) revert AlreadyConfigured();
        feed = feed_;
        vault = vault_;
        pool = pool_;
        price = initialPrice;

        _sub(collateralChainId, feed_, ANSWER_UPDATED);
        _sub(collateralChainId, vault_, COLLATERAL_LOCKED);
        _sub(collateralChainId, vault_, COLLATERAL_RELEASED);
        _sub(collateralChainId, vault_, COLLATERAL_SEIZED);
        _sub(debtChainId, pool_, DISBURSED);
        _sub(debtChainId, pool_, BORROW_REJECTED);
        _sub(debtChainId, pool_, REPAID);
        _sub(debtChainId, pool_, LIQUIDATED);
        emit Configured(feed_, vault_, pool_, initialPrice);
    }

    // ---------------------------------------------------------------- entry point

    function react(LogRecord calldata log) external onlySystem {
        uint256 t = log.topic0;
        if (log.chainId == collateralChainId) {
            if (log.contractAddress == feed) {
                if (t == ANSWER_UPDATED) _onAnswer(int256(log.topic1), log.topic2);
            } else if (log.contractAddress == vault) {
                uint256 id = log.topic1;
                if (t == COLLATERAL_LOCKED) {
                    (uint256 collateral, uint256 borrow) = abi.decode(log.data, (uint256, uint256));
                    _onLocked(id, address(uint160(log.topic2)), collateral, borrow);
                } else if (t == COLLATERAL_RELEASED) {
                    _finalize(id, Status.Releasing, Status.Released);
                } else if (t == COLLATERAL_SEIZED) {
                    _finalize(id, Status.Seizing, Status.Seized);
                }
            }
        } else if (log.chainId == debtChainId && log.contractAddress == pool) {
            uint256 id = log.topic1;
            if (t == DISBURSED) _onDisbursed(id);
            else if (t == BORROW_REJECTED) _onRejected(id);
            else if (t == REPAID) _onRepaid(id);
            else if (t == LIQUIDATED) _onLiquidated(id);
        }
    }

    /// @notice Re-sends a loan's pending callback if it hasn't been confirmed within RETRY_AFTER.
    /// Anyone may call it; destination callbacks are idempotent, so a retry can never double-act.
    function poke(uint256 id) external {
        Loan storage l = loans[id];
        Status s = l.status;
        if (block.timestamp < l.lastRequest + RETRY_AFTER) revert TooSoon(l.lastRequest + RETRY_AFTER);
        if (s == Status.Pending) _requestDisburse(id, l);
        else if (s == Status.Liquidating) _requestLiquidate(id, l);
        else if (s == Status.Seizing) _requestSeize(id, l);
        else if (s == Status.Releasing) _requestRelease(id, l);
        else if (s == Status.Active && !_healthy(l.collateral, l.debt, price, LIQ_THRESHOLD_BPS)) _startLiquidation(id, l);
        else revert NothingToRetry(s);
        emit Poked(id, s);
    }

    // ---------------------------------------------------------------- handlers

    function _onAnswer(int256 answer, uint256 round) internal {
        if (round <= lastRound || answer <= 0) return; // replayed, out of order or invalid
        lastRound = round;
        uint256 p = uint256(answer);
        price = p;
        emit PriceSeen(round, p);
        uint256 budget = MAX_LIQ_PER_SWEEP;
        for (uint256 i = active.length; i > 0 && budget > 0; i--) {
            uint256 id = active[i - 1];
            Loan storage l = loans[id];
            if (l.status == Status.Active && !_healthy(l.collateral, l.debt, p, LIQ_THRESHOLD_BPS)) {
                _startLiquidation(id, l);
                budget--;
            }
        }
    }

    function _onLocked(uint256 id, address borrower, uint256 collateral, uint256 borrow) internal {
        Loan storage l = loans[id];
        if (l.status != Status.None) return;
        l.borrower = borrower;
        l.collateral = uint128(collateral);
        l.debt = uint128(borrow);

        uint8 reason;
        if (borrow < MIN_DEBT) reason = REFUSE_TOO_SMALL;
        else if (!_healthy(collateral, borrow, price, MAX_LTV_BPS)) reason = REFUSE_LTV;
        else if (openTotal >= MAX_OPEN) reason = REFUSE_FULL;
        else if (openBy[borrower] >= MAX_OPEN_PER_BORROWER) reason = REFUSE_BORROWER_LIMIT;
        if (reason != 0) {
            emit BorrowRefused(id, reason);
            l.status = Status.Releasing;
            _requestRelease(id, l);
            return;
        }
        l.status = Status.Pending;
        openTotal++;
        openBy[borrower]++;
        emit BorrowApproved(id, collateral, borrow, price);
        _requestDisburse(id, l);
    }

    function _onDisbursed(uint256 id) internal {
        Loan storage l = loans[id];
        if (l.status != Status.Pending) return;
        l.status = Status.Active;
        active.push(id);
        activeIndex[id] = active.length;
        // The price may have moved while the loan was in flight.
        if (!_healthy(l.collateral, l.debt, price, LIQ_THRESHOLD_BPS)) _startLiquidation(id, l);
    }

    function _onRejected(uint256 id) internal {
        Loan storage l = loans[id];
        if (l.status != Status.Pending) return;
        _close(id, l);
        l.status = Status.Releasing;
        _requestRelease(id, l);
    }

    /// @dev A repay can race a liquidation request; if it lands first, the pool ignores the liquidation.
    function _onRepaid(uint256 id) internal {
        Loan storage l = loans[id];
        if (l.status != Status.Active && l.status != Status.Liquidating) return;
        _close(id, l);
        l.status = Status.Releasing;
        _requestRelease(id, l);
    }

    function _onLiquidated(uint256 id) internal {
        Loan storage l = loans[id];
        if (l.status != Status.Liquidating && l.status != Status.Active) return;
        if (l.seizeAmount == 0) l.seizeAmount = uint128(_seizeAmount(l.collateral, l.debt, price));
        _close(id, l);
        l.status = Status.Seizing;
        _requestSeize(id, l);
    }

    function _finalize(uint256 id, Status from, Status to) internal {
        Loan storage l = loans[id];
        if (l.status != from) return;
        l.status = to;
        emit LoanFinal(id, to);
    }

    // ---------------------------------------------------------------- requests

    function _startLiquidation(uint256 id, Loan storage l) internal {
        l.status = Status.Liquidating;
        l.seizeAmount = uint128(_seizeAmount(l.collateral, l.debt, price));
        emit LiquidationRequested(id, l.debt, price, l.seizeAmount);
        _requestLiquidate(id, l);
    }

    function _requestDisburse(uint256 id, Loan storage l) internal {
        l.lastRequest = uint64(block.timestamp);
        _callback(debtChainId, pool, abi.encodeWithSignature("disburse(address,uint256,address,uint256)", address(0), id, l.borrower, uint256(l.debt)));
    }

    function _requestLiquidate(uint256 id, Loan storage l) internal {
        l.lastRequest = uint64(block.timestamp);
        _callback(debtChainId, pool, abi.encodeWithSignature("liquidate(address,uint256)", address(0), id));
    }

    function _requestSeize(uint256 id, Loan storage l) internal {
        l.lastRequest = uint64(block.timestamp);
        emit SeizeRequested(id, l.seizeAmount);
        _callback(collateralChainId, vault, abi.encodeWithSignature("seize(address,uint256,uint256)", address(0), id, uint256(l.seizeAmount)));
    }

    function _requestRelease(uint256 id, Loan storage l) internal {
        l.lastRequest = uint64(block.timestamp);
        emit ReleaseRequested(id);
        _callback(collateralChainId, vault, abi.encodeWithSignature("release(address,uint256)", address(0), id));
    }

    // ---------------------------------------------------------------- helpers

    /// @dev debt (6 dp) vs collateral (18 dp) × price (8 dp), compared in 8 dp USD.
    function _healthy(uint256 collateral, uint256 debt, uint256 p, uint256 bps) internal pure returns (bool) {
        return debt * 100 * 10_000 <= ((collateral * p) / 1e18) * bps;
    }

    /// @dev Collateral worth debt × (1 + penalty) at price `p`, capped at the whole collateral.
    function _seizeAmount(uint256 collateral, uint256 debt, uint256 p) internal pure returns (uint256) {
        if (p == 0) return collateral;
        uint256 amount = (debt * 100 * 1e18 * (10_000 + LIQ_PENALTY_BPS)) / (p * 10_000);
        return amount < collateral ? amount : collateral;
    }

    /// @dev Leaves the open set (Pending/Active/Liquidating) and the active scan list.
    function _close(uint256 id, Loan storage l) internal {
        openTotal--;
        openBy[l.borrower]--;
        uint256 idx = activeIndex[id];
        if (idx == 0) return;
        uint256 last = active[active.length - 1];
        active[idx - 1] = last;
        activeIndex[last] = idx;
        active.pop();
        delete activeIndex[id];
    }

    function _sub(uint256 chainId, address target, uint256 topic0) internal {
        SYSTEM.subscribe(chainId, target, topic0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function _callback(uint256 chainId, address target, bytes memory payload) internal {
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({ chainId: chainId, recipient: target, gasLimit: CALLBACK_GAS, payload: payload })
        );
    }

    // ---------------------------------------------------------------- views

    function activeCount() external view returns (uint256) {
        return active.length;
    }

    function activeIds() external view returns (uint256[] memory) {
        return active;
    }

    /// @notice Pays any outstanding debt to the system contract. Anyone may call.
    function coverDebt() external {
        _coverDebt();
    }
}
