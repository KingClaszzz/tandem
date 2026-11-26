import type { Address } from "viem";
import type { Activity } from "../activity";
import type { Point } from "../charts";
import type { ChainHealth, Fuel, Loan, useLoop, useMarket } from "../market";
import type { Cost, SavedRun } from "../runs";

/** Everything a console view needs. Built once in the shell so each view stays a plain function of it. */
export type Ctx = {
  account?: Address;
  connect: () => void;
  hasWallet: boolean;
  m: ReturnType<typeof useMarket>;
  fuel: Fuel;
  chain: ChainHealth;
  busy?: string;
  halted: boolean;
  mine: Loan[];
  myOpen: number;
  moved: boolean;
  target?: number;
  setTarget: (p?: number) => void;
  loop: ReturnType<typeof useLoop>;
  cost?: Cost;
  feed: { events: Activity[]; tape: Point[] };
  myRuns: { runs: SavedRun[]; clear: () => void };
  act: {
    post: (p: number) => void;
    borrow: (coll: string, debt: number) => void;
    repay: (l: Loan) => void;
    poke: (l: Loan) => void;
    faucet: () => void;
    usdFaucet: () => void;
  };
};
