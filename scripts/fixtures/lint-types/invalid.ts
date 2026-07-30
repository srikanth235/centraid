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
