// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { AbstractReactive } from "./reactive-lib/base/AbstractReactive.sol";
import { ISystemContract } from "./reactive-lib/interfaces/ISystemContract.sol";

/// @notice Runs on Reactive (Lasna). Mirrors every loan and the collateral price, and drives the
/// cross-chain lending loops:
///   borrow:      CollateralLocked (Base)  -> disburse  (Unichain)   or release (Base) if LTV too high
///   repay:       Repaid (Unichain)        -> release   (Base)
///   liquidation: PriceUpdated (Base)      -> liquidate (Unichain) -> Liquidated -> seize (Base)
contract TandemReactive is AbstractReactive {
    // Risk parameters, in basis points.
    uint256 public constant MAX_LTV_BPS = 7_000;
    uint256 public constant LIQ_THRESHOLD_BPS = 8_000;
    uint256 public constant MAX_ACTIVE = 25;
    uint64 public constant CALLBACK_GAS = 400_000;

    // keccak256 of the origin events' signatures.
    uint256 private constant PRICE_UPDATED = uint256(keccak256("PriceUpdated(uint256,uint256,address)"));
    uint256 private constant COLLATERAL_LOCKED = uint256(keccak256("CollateralLocked(uint256,address,uint256,uint256)"));
    uint256 private constant DISBURSED = uint256(keccak256("Disbursed(uint256,address,uint256)"));
    uint256 private constant BORROW_REJECTED = uint256(keccak256("BorrowRejected(uint256,address,uint256)"));
    uint256 private constant REPAID = uint256(keccak256("Repaid(uint256,address,uint256)"));
    uint256 private constant LIQUIDATED = uint256(keccak256("Liquidated(uint256,address,uint256)"));

    enum Status { None, Pending, Active, Liquidating, Closed }

    struct Loan {
        uint128 collateral; // collateral token, 18 decimals
        uint128 debt;       // loan asset, 6 decimals
        Status status;
    }

    address public immutable owner;
    uint256 public immutable collateralChainId;
    uint256 public immutable debtChainId;

    address public feed;
    address public vault;
    address public pool;
    uint256 public price; // USD, 8 decimals

    mapping(uint256 => Loan) public loans;
    uint256[] public active;
    mapping(uint256 => uint256) private activeIndex; // loanId => index + 1

    event Configured(address feed, address vault, address pool, uint256 price);
    event PriceSeen(uint256 price);
    event BorrowApproved(uint256 indexed loanId, uint256 collateral, uint256 debt, uint256 price);
    event BorrowRefused(uint256 indexed loanId, uint256 collateral, uint256 debt, uint256 price);
    event LiquidationRequested(uint256 indexed loanId, uint256 collateral, uint256 debt, uint256 price);
    event SeizeRequested(uint256 indexed loanId);
    event ReleaseRequested(uint256 indexed loanId);

    error NotOwner();
    error AlreadyConfigured();

    constructor(uint256 collateralChainId_, uint256 debtChainId_) payable {
        owner = msg.sender;
        collateralChainId = collateralChainId_;
        debtChainId = debtChainId_;
    }

    /// @notice One-time wiring, after the origin/destination contracts exist (they need this
    /// contract's address as their authorized callback sender, so they are deployed after it).
    function configure(address feed_, address vault_, address pool_, uint256 initialPrice) external {
        if (msg.sender != owner) revert NotOwner();
        if (feed != address(0)) revert AlreadyConfigured();
        feed = feed_;
        vault = vault_;
        pool = pool_;
        price = initialPrice;

        _sub(collateralChainId, feed_, PRICE_UPDATED);
        _sub(collateralChainId, vault_, COLLATERAL_LOCKED);
        _sub(debtChainId, pool_, DISBURSED);
        _sub(debtChainId, pool_, BORROW_REJECTED);
        _sub(debtChainId, pool_, REPAID);
        _sub(debtChainId, pool_, LIQUIDATED);
        emit Configured(feed_, vault_, pool_, initialPrice);
    }

    function react(LogRecord calldata log) external onlySystem {
        uint256 t = log.topic0;
        if (log.chainId == collateralChainId) {
            if (log.contractAddress == feed && t == PRICE_UPDATED) {
                (uint256 p) = abi.decode(log.data, (uint256));
                _onPrice(p);
            } else if (log.contractAddress == vault && t == COLLATERAL_LOCKED) {
                (uint256 collateral, uint256 borrow) = abi.decode(log.data, (uint256, uint256));
                _onLocked(log.topic1, address(uint160(log.topic2)), collateral, borrow);
            }
        } else if (log.chainId == debtChainId && log.contractAddress == pool) {
            uint256 id = log.topic1;
            if (t == DISBURSED) _onDisbursed(id);
            else if (t == BORROW_REJECTED) _close(id, true);
            else if (t == REPAID) _close(id, true);
            else if (t == LIQUIDATED) _onLiquidated(id);
        }
    }

    // ---------------------------------------------------------------- handlers

    function _onPrice(uint256 p) internal {
        price = p;
        emit PriceSeen(p);
        // Walk backwards so removals don't skip entries.
        for (uint256 i = active.length; i > 0; i--) {
            uint256 id = active[i - 1];
            Loan storage l = loans[id];
            if (l.status == Status.Active && !_healthy(l.collateral, l.debt, p, LIQ_THRESHOLD_BPS)) {
                _liquidate(id, l);
            }
        }
    }

    function _onLocked(uint256 id, address borrower, uint256 collateral, uint256 borrow) internal {
        if (loans[id].status != Status.None) return;
        loans[id] = Loan(uint128(collateral), uint128(borrow), Status.Pending);
        if (active.length >= MAX_ACTIVE || !_healthy(collateral, borrow, price, MAX_LTV_BPS)) {
            emit BorrowRefused(id, collateral, borrow, price);
            _close(id, true);
            return;
        }
        emit BorrowApproved(id, collateral, borrow, price);
        _callback(debtChainId, pool, abi.encodeWithSignature("disburse(address,uint256,address,uint256)", address(0), id, borrower, borrow));
    }

    function _onDisbursed(uint256 id) internal {
        Loan storage l = loans[id];
        if (l.status != Status.Pending) return;
        l.status = Status.Active;
        active.push(id);
        activeIndex[id] = active.length;
        // The price may have moved while the loan was in flight.
        if (!_healthy(l.collateral, l.debt, price, LIQ_THRESHOLD_BPS)) _liquidate(id, l);
    }

    function _onLiquidated(uint256 id) internal {
        Loan storage l = loans[id];
        if (l.status == Status.Closed || l.status == Status.None) return;
        l.status = Status.Closed;
        _removeActive(id);
        emit SeizeRequested(id);
        _callback(collateralChainId, vault, abi.encodeWithSignature("seize(address,uint256)", address(0), id));
    }

    function _liquidate(uint256 id, Loan storage l) internal {
        l.status = Status.Liquidating;
        emit LiquidationRequested(id, l.collateral, l.debt, price);
        _callback(debtChainId, pool, abi.encodeWithSignature("liquidate(address,uint256)", address(0), id));
    }

    /// @dev Repaid, or borrow refused/rejected: give the collateral back.
    function _close(uint256 id, bool release) internal {
        Loan storage l = loans[id];
        if (l.status == Status.Closed || l.status == Status.None) return;
        l.status = Status.Closed;
        _removeActive(id);
        if (release) {
            emit ReleaseRequested(id);
            _callback(collateralChainId, vault, abi.encodeWithSignature("release(address,uint256)", address(0), id));
        }
    }

    // ---------------------------------------------------------------- helpers

    /// @dev debt (6 dp) <= collateral (18 dp) * price (8 dp) * bps, all in 8 dp USD.
    function _healthy(uint256 collateral, uint256 debt, uint256 p, uint256 bps) internal pure returns (bool) {
        uint256 value = (collateral * p) / 1e18;
        return debt * 100 * 10_000 <= value * bps;
    }

    function _removeActive(uint256 id) internal {
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
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: chainId,
                recipient: target,
                gasLimit: CALLBACK_GAS,
                payload: payload
            })
        );
    }

    function activeCount() external view returns (uint256) {
        return active.length;
    }

    function coverDebt() external {
        _coverDebt();
    }
}
