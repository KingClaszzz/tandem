import { describe, expect, it } from "vitest";
import { liqPrice, ltv, stageOf, wouldLiquidate, type Loan } from "./market";
import { RC } from "./chain";

const loan = (o: Partial<Loan> = {}): Loan => ({ id: 1n, owner: "0x0000000000000000000000000000000000000001", collateral: 0.05, debt: 90, vault: 1, pool: 1, ...o });

describe("loan math (mirrors TandemReactive._healthy)", () => {
  it("ltv is debt over collateral value", () => {
    expect(ltv(loan(), 3000)).toBeCloseTo(0.6, 10);
    expect(ltv(loan({ collateral: 0 }), 3000)).toBe(0);
    expect(ltv(loan(), 0)).toBe(0);
  });

  it("liquidation price is where LTV reaches 80%", () => {
    const l = loan();
    expect(liqPrice(l)).toBeCloseTo(2250, 8);
    expect(ltv(l, liqPrice(l))).toBeCloseTo(0.8, 10);
  });

  it("wouldLiquidate is strictly above 80% and ignores loans that are not active", () => {
    const active = loan();
    const seized = loan({ id: 2n, vault: 3, pool: 3 });
    const repaid = loan({ id: 3n, vault: 2, pool: 2 });
    expect(wouldLiquidate([active, seized, repaid], 2249).map((l) => l.id)).toEqual([1n]);
    expect(wouldLiquidate([active, seized, repaid], 2251)).toEqual([]);
    expect(wouldLiquidate([active], 3000)).toEqual([]);
  });
});

describe("stageOf", () => {
  it("collateral already seized or released is final", () => {
    expect(stageOf(loan({ vault: 3, pool: 3 }))).toBe("seized");
    expect(stageOf(loan({ vault: 2, pool: 2 }))).toBe("repaid");
    expect(stageOf(loan({ vault: 2, pool: 0 }))).toBe("refused");
    expect(stageOf(loan({ vault: 2, pool: 4 }))).toBe("rejected");
  });

  it("prefers the reactive contract's own status while collateral is locked", () => {
    expect(stageOf(loan({ rc: RC.Pending, pool: 0 }))).toBe("waiting");
    expect(stageOf(loan({ rc: RC.Active }))).toBe("active");
    expect(stageOf(loan({ rc: RC.Liquidating }))).toBe("liquidating");
    expect(stageOf(loan({ rc: RC.Seizing, pool: 3 }))).toBe("seizing");
    expect(stageOf(loan({ rc: RC.Releasing, pool: 2 }))).toBe("releasing");
  });

  it("falls back to the pool's state when the reactive contract can't be read", () => {
    expect(stageOf(loan({ pool: 1 }))).toBe("active");
    expect(stageOf(loan({ pool: 3 }))).toBe("seizing");
    expect(stageOf(loan({ pool: 2 }))).toBe("releasing");
    expect(stageOf(loan({ pool: 0 }))).toBe("waiting");
  });
});
