async function resolvesNothing(): Promise<void> {}

export function misusesPromiseCallback(values: number[]): void {
  values.forEach(async () => resolvesNothing());
}

export async function awaitsANumber(): Promise<void> {
  // oxlint-disable-next-line unicorn/no-unnecessary-await -- This negative fixture must violate typescript/await-thenable.
  await 1;
}

type FixtureState = "ready" | "stopped";

export function missesAState(state: FixtureState): number {
  switch (state) {
    case "ready":
      return 1;
  }
  return 0;
}

export function floatsAPromise(): void {
  resolvesNothing();
}

export function indexesAnArray(values: string[]): void {
  for (const index in values) {
    if (Object.hasOwn(values, index)) console.log(index);
  }
}

export function throwsAString(): never {
  throw "not an Error";
}

export function rejectsWithAString(): Promise<never> {
  return Promise.reject("not an Error");
}

export function sortsWithoutAComparator(values: number[]): number[] {
  return values.sort();
}
