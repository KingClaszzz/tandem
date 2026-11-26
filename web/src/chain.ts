import { createPublicClient, defineChain, http, parseAbi, type Address, type Chain } from "viem";
import { baseSepolia, unichainSepolia } from "viem/chains";
import raw from "./deployments.json";

export const lasna = defineChain({
  id: 5318007,
  name: "Reactive Lasna",
  nativeCurrency: { name: "Lasna REACT", symbol: "lREACT", decimals: 18 },
  rpcUrls: { default: { http: ["https://lasna-rpc.rnk.dev/"] } },
  blockExplorers: { default: { name: "Reactscan", url: "https://lasna.reactscan.net" } },
  testnet: true,
});

export type Lane = "base" | "lasna" | "uni";
export const LANES: Lane[] = ["base", "lasna", "uni"];
export const CHAIN: Record<Lane, Chain> = { base: baseSepolia, lasna, uni: unichainSepolia };
export const LANE_NAME: Record<Lane, string> = { base: "Base Sepolia", lasna: "Reactive Lasna", uni: "Unichain Sepolia" };
export const LANE_SHORT: Record<Lane, string> = { base: "Base", lasna: "Lasna", uni: "Unichain" };
const EXPLORER: Record<Lane, string> = {
  base: "https://sepolia.basescan.org",
  lasna: "https://lasna.reactscan.net",
  uni: "https://sepolia.uniscan.xyz",
};
export const txUrl = (l: Lane, h: string) => `${EXPLORER[l]}/tx/${h}`;
export const addrUrl = (l: Lane, a: string) => `${EXPLORER[l]}/address/${a}`;
export const sourcifyUrl = (l: Lane, a: string) => `https://repo.sourcify.dev/${CHAIN[l].id}/${a}`;

// Public RPCs are shared and rate limited: batch calls into one HTTP request, fail fast, retry twice.
const rpc = () => http(undefined, { batch: { wait: 20 }, timeout: 10_000, retryCount: 2, retryDelay: 400 });
export const client = {
  base: createPublicClient({ chain: baseSepolia, transport: rpc() }),
  lasna: createPublicClient({ chain: lasna, transport: rpc() }),
  uni: createPublicClient({ chain: unichainSepolia, transport: rpc() }),
};

type Entry = { chain: Lane; address: Address; tx?: string };
type Key = "reactive" | "tWETH" | "feed" | "vault" | "tUSD" | "pool";
const d = raw as Partial<Record<Key, Entry>> & { _meta?: { configured?: string; deployedAt?: string } };
export const deployed = Boolean(d.reactive && d.pool && d._meta?.configured);
export const ADDR = {
  rc: d.reactive?.address as Address,
  weth: d.tWETH?.address as Address,
  feed: d.feed?.address as Address,
  vault: d.vault?.address as Address,
  usd: d.tUSD?.address as Address,
  pool: d.pool?.address as Address,
};
export const DEPLOYMENTS = d;

// What the network charges a contract for: reactions on Lasna (lREACT), callbacks on the destination chains (ETH).
export const SYSTEM = "0x8888888888888888888888888888888888888888" as Address;
export const PROXY = {
  base: "0x476F44b11F5C942c58f4c8E3d0300E5710743585" as Address,
  uni: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1" as Address,
};
export const debtAbi = parseAbi(["function debt(address) view returns (uint256)"]);
/** Measured on 2026-11-25: about 0.017 lREACT per reactive execution. */
export const REACTION_COST = 0.017;
export const LOW_FUEL = 0.1; // lREACT: warn below this
export const MIN_FUEL = 0.04; // lREACT: refuse new loans below this

export const abi = {
  token: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function faucet()",
    "function lastDrip(address) view returns (uint256)",
    "error TooSoon(uint256 nextAt)",
  ]),
  feed: parseAbi([
    "function latestAnswer() view returns (int256)",
    "function latestRound() view returns (uint256)",
    "function latestTimestamp() view returns (uint256)",
    "function MIN_INTERVAL() view returns (uint256)",
    "function post(int256 answer)",
    "error TooSoon(uint256 nextAt)",
    "error NoChange()",
    "error MoveTooLarge(int256 previous, int256 answer)",
    "error OutOfBounds(int256 answer)",
    "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)",
  ]),
  vault: parseAbi([
    "function lock(uint256 amount, uint256 borrowAmount) returns (uint256)",
    "function nextId() view returns (uint256)",
    "function MAX_BORROW() view returns (uint256)",
    "function treasury() view returns (address)",
    "function loans(uint256) view returns (address owner, uint128 collateral, uint8 status)",
    "error ZeroAmount()",
    "error BorrowOutOfRange(uint256 min, uint256 max)",
    "error TooManyLoans()",
    "event CollateralLocked(uint256 indexed loanId, address indexed owner, uint256 collateral, uint256 borrowAmount)",
    "event CollateralReleased(uint256 indexed loanId, address indexed owner, uint256 collateral)",
    "event CollateralSeized(uint256 indexed loanId, address indexed owner, uint256 seized, uint256 returned)",
  ]),
  pool: parseAbi([
    "function loans(uint256) view returns (address borrower, uint128 debt, uint8 status)",
    "function liquidity() view returns (uint256)",
    "function repay(uint256 loanId)",
    "error NotActive()",
    "event Disbursed(uint256 indexed loanId, address indexed borrower, uint256 amount)",
    "event BorrowRejected(uint256 indexed loanId, address indexed borrower, uint256 amount)",
    "event Repaid(uint256 indexed loanId, address indexed payer, uint256 amount)",
    "event Liquidated(uint256 indexed loanId, address indexed borrower, uint256 debt)",
  ]),
  rc: parseAbi([
    "function price() view returns (uint256)",
    "function lastRound() view returns (uint256)",
    "function openTotal() view returns (uint256)",
    "function loans(uint256) view returns (address borrower, uint64 lastRequest, uint8 status, uint128 collateral, uint128 debt, uint128 seizeAmount)",
    "function poke(uint256 id)",
    "error TooSoon(uint256 retryAt)",
    "error NothingToRetry(uint8 status)",
    "event PriceSeen(uint256 indexed round, uint256 price)",
    "event BorrowApproved(uint256 indexed loanId, uint256 collateral, uint256 debt, uint256 price)",
    "event BorrowRefused(uint256 indexed loanId, uint8 reason)",
    "event LiquidationRequested(uint256 indexed loanId, uint256 debt, uint256 price, uint256 seizeAmount)",
    "event SeizeRequested(uint256 indexed loanId, uint256 seizeAmount)",
    "event ReleaseRequested(uint256 indexed loanId)",
    "event LoanFinal(uint256 indexed loanId, uint8 status)",
  ]),
};

// Mirrors the constants in TandemReactive / PriceFeed. docs/DESIGN.md is the source of truth.
export const MAX_LTV = 0.7;
export const LIQ_THRESHOLD = 0.8;
export const PENALTY = 0.05;
export const MIN_DEBT = 50;
export const MAX_PER_BORROWER = 3;
export const RETRY_AFTER = 60;
export const PRICE_MIN = 100;
export const PRICE_MAX = 20_000;
export const MAX_MOVE = 0.5;
export const START_PRICE = 3000;

export const RC = { None: 0, Pending: 1, Active: 2, Liquidating: 3, Seizing: 4, Releasing: 5, Released: 6, Seized: 7 } as const;
export const RC_LABEL = ["None", "Pending", "Active", "Liquidating", "Seizing", "Releasing", "Released", "Seized"] as const;
export const BORROW_REFUSED = ["", "above 70% LTV", "below the 50 tUSD minimum", "reactive contract is full", "3 open loans already", "out of range"] as const;
