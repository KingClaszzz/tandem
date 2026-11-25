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
export const CHAIN: Record<Lane, Chain> = { base: baseSepolia, lasna, uni: unichainSepolia };
export const LANE_NAME: Record<Lane, string> = { base: "Base Sepolia", lasna: "Reactive Lasna", uni: "Unichain Sepolia" };
const EXPLORER: Record<Lane, string> = {
  base: "https://sepolia.basescan.org",
  lasna: "https://lasna.reactscan.net",
  uni: "https://sepolia.uniscan.xyz",
};
export const txUrl = (l: Lane, h: string) => `${EXPLORER[l]}/tx/${h}`;
export const addrUrl = (l: Lane, a: string) => `${EXPLORER[l]}/address/${a}`;

export const client = {
  base: createPublicClient({ chain: baseSepolia, transport: http() }),
  lasna: createPublicClient({ chain: lasna, transport: http() }),
  uni: createPublicClient({ chain: unichainSepolia, transport: http() }),
};

type Entry = { chain: "base" | "lasna" | "uni"; address: Address; tx?: string };
const d = raw as Partial<Record<"reactive" | "tWETH" | "feed" | "vault" | "tUSD" | "pool", Entry>> & { _meta?: { configured?: string; deployedAt?: string } };
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

export const abi = {
  token: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function faucet()",
    "function lastDrip(address) view returns (uint256)",
  ]),
  feed: parseAbi([
    "function price() view returns (uint256)",
    "function setPrice(uint256)",
    "event PriceUpdated(uint256 indexed round, uint256 price, address indexed by)",
  ]),
  vault: parseAbi([
    "function lock(uint256 amount, uint256 borrowAmount) returns (uint256)",
    "function nextId() view returns (uint256)",
    "function loans(uint256) view returns (address owner, uint128 collateral, uint8 status)",
    "event CollateralLocked(uint256 indexed loanId, address indexed owner, uint256 collateral, uint256 borrowAmount)",
    "event CollateralReleased(uint256 indexed loanId, address indexed owner, uint256 collateral)",
    "event CollateralSeized(uint256 indexed loanId, address indexed owner, uint256 collateral)",
  ]),
  pool: parseAbi([
    "function loans(uint256) view returns (address borrower, uint128 debt, uint8 status)",
    "function repay(uint256 loanId)",
    "event Disbursed(uint256 indexed loanId, address indexed borrower, uint256 amount)",
    "event BorrowRejected(uint256 indexed loanId, address indexed borrower, uint256 amount)",
    "event Repaid(uint256 indexed loanId, address indexed payer, uint256 amount)",
    "event Liquidated(uint256 indexed loanId, address indexed borrower, uint256 debt)",
  ]),
  rc: parseAbi([
    "function price() view returns (uint256)",
    "function activeCount() view returns (uint256)",
    "event PriceSeen(uint256 price)",
    "event BorrowApproved(uint256 indexed loanId, uint256 collateral, uint256 debt, uint256 price)",
    "event BorrowRefused(uint256 indexed loanId, uint256 collateral, uint256 debt, uint256 price)",
    "event LiquidationRequested(uint256 indexed loanId, uint256 collateral, uint256 debt, uint256 price)",
    "event SeizeRequested(uint256 indexed loanId)",
    "event ReleaseRequested(uint256 indexed loanId)",
  ]),
};

// Mirrors TandemReactive's constants.
export const MAX_LTV = 0.7;
export const LIQ_THRESHOLD = 0.8;
export const PRICE_MIN = 100;
export const PRICE_MAX = 20_000;

export const VaultStatus = ["None", "Locked", "Released", "Seized"] as const;
export const PoolStatus = ["None", "Active", "Repaid", "Liquidated"] as const;
