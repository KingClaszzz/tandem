// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Demo ETH/USD feed on Base Sepolia, 8 decimals. It emits the same event as Chainlink's
/// OCR aggregators (`AnswerUpdated`) and exposes `latestRoundData()`, so TandemReactive can be
/// pointed at a real aggregator unchanged. Anyone may post, so judges can trigger a liquidation;
/// guardrails: $100–$20,000 and at most a 50% move per update. Not an oracle. See docs/DESIGN.md §2.
contract PriceFeed {
    uint8 public constant decimals = 8;
    int256 public constant MIN_ANSWER = 100e8;
    int256 public constant MAX_ANSWER = 20_000e8;
    uint256 public constant MAX_MOVE_BPS = 5_000;

    int256 public latestAnswer;
    uint256 public latestRound;
    uint256 public latestTimestamp;

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    error OutOfBounds(int256 answer);
    error MoveTooLarge(int256 previous, int256 answer);

    constructor(int256 initialAnswer) {
        _post(initialAnswer);
    }

    function post(int256 answer) external {
        _post(answer);
    }

    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) {
        return (uint80(latestRound), latestAnswer, latestTimestamp, latestTimestamp, uint80(latestRound));
    }

    function _post(int256 answer) internal {
        if (answer < MIN_ANSWER || answer > MAX_ANSWER) revert OutOfBounds(answer);
        int256 prev = latestAnswer;
        if (prev != 0) {
            uint256 diff = uint256(answer > prev ? answer - prev : prev - answer);
            if (diff * 10_000 > uint256(prev) * MAX_MOVE_BPS) revert MoveTooLarge(prev, answer);
        }
        latestAnswer = answer;
        latestTimestamp = block.timestamp;
        emit AnswerUpdated(answer, ++latestRound, block.timestamp);
    }
}
