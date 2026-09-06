// MONEY KEEPS ITS CURRENCY (#996, ruling R22; drift ONT-23).
//
// Tally's `pairwise` accumulated minor units into a map keyed by PARTY ALONE,
// and the dashboard labelled the sum with the vault's base currency. A EUR 100
// debt and a USD 100 debt therefore read as one 200 — a number that is not
// true in any currency, rendered as if it were.
//
// The fix is a type, not a check. A balance is `Money`, never a number, so a
// bare amount cannot be rendered as one; a position that spans currencies is a
// `MoneyBag` and stays several amounts; and a single figure over several
// currencies is a `Valuation`, which either carries the rate that produced it
// or says it is UNAVAILABLE. There is no rate source in the product yet, so
// the honest answer today is `unavailable` with the components — and the type
// makes that answer impossible to skip.

/** An amount in the minor units of ONE currency. */
export interface Money {
  readonly amount_minor: number;
  /** ISO 4217, three letters, upper case. */
  readonly currency: string;
}

/** A position that may span currencies: at most one entry per currency, sorted
 *  by currency, zero entries dropped. Never summed into one number. */
export type MoneyBag = readonly Money[];

export class CurrencyMismatchError extends Error {
  constructor(
    readonly left: string,
    readonly right: string
  ) {
    super(
      `${left} and ${right} are different currencies — adding them would produce a number that is true in neither.`
    );
    this.name = "CurrencyMismatchError";
  }
}

export function money(amountMinor: number, currency: string): Money {
  return {
    amount_minor: Math.round(amountMinor),
    currency: currency.toUpperCase(),
  };
}

export function zeroMoney(currency: string): Money {
  return money(0, currency);
}

export function isZeroMoney(value: Money): boolean {
  return value.amount_minor === 0;
}

export function negateMoney(value: Money): Money {
  return money(-value.amount_minor, value.currency);
}

/** Adds two amounts of the SAME currency. Different currencies throw — this is
 *  the addition ONT-23 was doing silently. */
export function addMoney(left: Money, right: Money): Money {
  if (left.currency !== right.currency) {
    throw new CurrencyMismatchError(left.currency, right.currency);
  }
  return money(left.amount_minor + right.amount_minor, left.currency);
}

function normalizeBag(totals: ReadonlyMap<string, number>): MoneyBag {
  return [...totals.entries()]
    .filter(([, amount]) => amount !== 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => money(amount, currency));
}

export const EMPTY_BAG: MoneyBag = [];

/** A bag from any number of amounts, folded per currency. */
export function moneyBag(...amounts: readonly Money[]): MoneyBag {
  const totals = new Map<string, number>();
  for (const amount of amounts) {
    const currency = amount.currency.toUpperCase();
    totals.set(currency, (totals.get(currency) ?? 0) + amount.amount_minor);
  }
  return normalizeBag(totals);
}

export function addToBag(bag: MoneyBag, amount: Money): MoneyBag {
  return moneyBag(...bag, amount);
}

export function addBags(left: MoneyBag, right: MoneyBag): MoneyBag {
  return moneyBag(...left, ...right);
}

export function negateBag(bag: MoneyBag): MoneyBag {
  return bag.map(negateMoney);
}

/** The currencies a position is held in, sorted. A bag of length > 1 is what
 *  no single figure can honestly summarise without a rate. */
export function bagCurrencies(bag: MoneyBag): string[] {
  return bag.map((amount) => amount.currency);
}

/** Only the entries on one side of zero, sign preserved. */
export function bagWhere(
  bag: MoneyBag,
  predicate: (amount: Money) => boolean
): MoneyBag {
  return bag.filter(predicate);
}

/** The amount held in `currency`, zero when the bag holds none of it. */
export function bagIn(bag: MoneyBag, currency: string): Money {
  const wanted = currency.toUpperCase();
  return bag.find((amount) => amount.currency === wanted) ?? zeroMoney(wanted);
}

/** A rate actually used to produce a valuation — never implied. */
export interface ValuationRate {
  readonly from: string;
  readonly to: string;
  /** `rate_scaled / 10^rate_scale`, the vault's fixed-point pair. */
  readonly rate_scaled: number;
  readonly rate_scale: number;
  readonly source: string;
  readonly effective_at: string;
}

/**
 * A single figure over a position, and the reason it can be one.
 *
 * `valued` carries the rates that produced it, so a member can be shown what
 * the number assumes. `unavailable` carries the components, so a surface that
 * cannot show one number can still show the several that are true.
 */
export type Valuation =
  | {
      readonly state: "valued";
      readonly total: Money;
      readonly rates: readonly ValuationRate[];
      readonly components: MoneyBag;
    }
  | {
      readonly state: "unavailable";
      readonly reason: "no-rate-source";
      readonly currencies: readonly string[];
      readonly components: MoneyBag;
    };

/**
 * Value a position in `base`.
 *
 * With nothing to convert — an empty position, or one held entirely in `base`
 * — the answer is `valued` with no rates, because no rate was used. With more
 * than one currency and no rate source, the answer is `unavailable`: there is
 * no rate plane in the product yet (a later proposal), and inventing one is
 * exactly the arithmetic ONT-23 filed.
 */
export function valuate(
  bag: MoneyBag,
  base: string,
  rates: readonly ValuationRate[] = []
): Valuation {
  const wanted = base.toUpperCase();
  const foreign = bag.filter((amount) => amount.currency !== wanted);
  if (foreign.length === 0) {
    return {
      state: "valued",
      total: bagIn(bag, wanted),
      rates: [],
      components: bag,
    };
  }
  const converted: Money[] = [bagIn(bag, wanted)];
  const used: ValuationRate[] = [];
  for (const amount of foreign) {
    const rate = rates.find(
      (candidate) =>
        candidate.from === amount.currency && candidate.to === wanted
    );
    if (!rate) {
      return {
        state: "unavailable",
        reason: "no-rate-source",
        currencies: bagCurrencies(bag),
        components: bag,
      };
    }
    used.push(rate);
    converted.push(
      money(
        Math.round(
          (amount.amount_minor * rate.rate_scaled) / 10 ** rate.rate_scale
        ),
        wanted
      )
    );
  }
  return {
    state: "valued",
    total: converted.reduce(addMoney, zeroMoney(wanted)),
    rates: used,
    components: bag,
  };
}

/** The rates a valuation used, or none. */
function ratesOf(valuation: Valuation): readonly ValuationRate[] {
  return valuation.state === "valued" ? valuation.rates : [];
}

/**
 * `owed` less `owe`, as one valuation. Two valuations do not subtract as
 * numbers — each is a position first and a figure second — so the difference
 * is taken over the COMPONENTS and valued once, which is what keeps
 * "unavailable minus unavailable" from becoming a number.
 */
export function netValuation(
  owed: Valuation,
  owe: Valuation,
  base: string
): Valuation {
  return valuate(addBags(owed.components, negateBag(owe.components)), base, [
    ...ratesOf(owed),
    ...ratesOf(owe),
  ]);
}
