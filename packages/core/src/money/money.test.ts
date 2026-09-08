// USD 100 + EUR 100 is not USD 200 (#996, ruling R22; drift ONT-23).

import { describe, expect, it } from "vitest";

import {
  addBags,
  addMoney,
  bagCurrencies,
  bagIn,
  CurrencyMismatchError,
  money,
  moneyBag,
  negateBag,
  valuate,
} from "./index.js";

describe("Money keeps its currency", () => {
  it("refuses to add two currencies rather than producing a third number", () => {
    expect(() => addMoney(money(10_000, "USD"), money(10_000, "EUR"))).toThrow(
      CurrencyMismatchError
    );
    expect(addMoney(money(10_000, "USD"), money(500, "usd"))).toStrictEqual(
      money(10_500, "USD")
    );
  });

  it("folds a position per currency and drops the zeros", () => {
    const bag = moneyBag(
      money(10_000, "USD"),
      money(10_000, "EUR"),
      money(-10_000, "EUR"),
      money(2_500, "usd")
    );
    expect(bag).toStrictEqual([money(12_500, "USD")]);
  });

  it("keeps two currencies as two amounts, sorted", () => {
    const bag = addBags(
      moneyBag(money(10_000, "USD")),
      moneyBag(money(10_000, "EUR"))
    );
    expect(bagCurrencies(bag)).toStrictEqual(["EUR", "USD"]);
    expect(bagIn(bag, "EUR")).toStrictEqual(money(10_000, "EUR"));
    expect(bagIn(bag, "GBP")).toStrictEqual(money(0, "GBP"));
    expect(negateBag(bag)).toStrictEqual([
      money(-10_000, "EUR"),
      money(-10_000, "USD"),
    ]);
  });

  it("values a single-currency position without inventing a rate", () => {
    const bag = moneyBag(money(10_000, "USD"));
    expect(valuate(bag, "USD")).toStrictEqual({
      state: "valued",
      total: money(10_000, "USD"),
      rates: [],
      components: bag,
    });
  });

  it("refuses a single figure over two currencies when no rate source exists", () => {
    // THE SCENARIO ONT-23 FILED. Before this the two folded into 20_000 and
    // were labelled with the vault's base currency.
    const bag = addBags(
      moneyBag(money(10_000, "USD")),
      moneyBag(money(10_000, "EUR"))
    );
    const valuation = valuate(bag, "USD");
    expect(valuation.state).toBe("unavailable");
    expect(valuation).toStrictEqual({
      state: "unavailable",
      reason: "no-rate-source",
      currencies: ["EUR", "USD"],
      components: bag,
    });
  });

  it("values across currencies only with a rate, and says which", () => {
    const bag = addBags(
      moneyBag(money(10_000, "USD")),
      moneyBag(money(10_000, "EUR"))
    );
    const rate = {
      from: "EUR",
      to: "USD",
      rate_scaled: 1_200_000,
      rate_scale: 6,
      source: "manual",
      effective_at: "2026-01-15",
    };
    const valuation = valuate(bag, "USD", [rate]);
    expect(valuation).toStrictEqual({
      state: "valued",
      total: money(22_000, "USD"),
      rates: [rate],
      components: bag,
    });
  });
});
