import { promises as dns } from "node:dns";

const IPV4_RE = /^(?<a>\d{1,3})\.(?<b>\d{1,3})\.(?<c>\d{1,3})\.(?<d>\d{1,3})$/u;

type Ipv4 = readonly [number, number, number, number];

function parseIpv4(text: string): Ipv4 | undefined {
  const match = IPV4_RE.exec(text);
  if (!match) return undefined;
  const [a, b, c, d] = [
    Number(match.groups!.a),
    Number(match.groups!.b),
    Number(match.groups!.c),
    Number(match.groups!.d),
  ];
  if ([a, b, c, d].some((n) => n > 255)) return undefined;
  return [a!, b!, c!, d!];
}

function ipv4IsReserved(parts: Ipv4): boolean {
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 240 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0)
  );
}

function parseIpv6(text: string): readonly number[] | undefined {
  const embedded = /(?:^|:)(?<tail>\d{1,3}(?:\.\d{1,3}){3})$/u.exec(text);
  let rest = text;
  if (embedded) {
    const v4 = parseIpv4(embedded.groups!.tail!);
    if (!v4) return undefined;
    rest =
      text.slice(0, embedded.index + 1) +
      [
        ((v4[0] << 8) | v4[1]).toString(16),
        ((v4[2] << 8) | v4[3]).toString(16),
      ].join(":");
  }
  const groupsOf = (side: string): readonly number[] | undefined => {
    if (side === "") return [];
    const out: number[] = [];
    for (const group of side.split(":")) {
      if (!/^[0-9a-f]{1,4}$/iu.test(group)) return undefined;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const halves = rest.split("::");
  if (halves.length > 2) return undefined;
  const head = groupsOf(halves[0]!);
  if (!head) return undefined;
  const rear = halves.length === 2 ? groupsOf(halves[1]!) : [];
  if (!rear) return undefined;
  const total = head.length + rear.length;
  if (halves.length === 1 ? total !== 8 : total >= 8) return undefined;
  return [...head, ...Array.from({ length: 8 - total }, () => 0), ...rear];
}

function ipv6IsReserved(groups: readonly number[]): boolean {
  const leadingZeros = (count: number): boolean =>
    groups.slice(0, count).every((group) => group === 0);
  if (groups.every((group) => group === 0)) return true;
  if (leadingZeros(6)) return true;
  if (leadingZeros(5) && groups[5] === 0xffff) return true;
  if (groups[0] === 0x64 && groups[1] === 0xff9b) return true;
  const first = groups[0]!;
  return (
    (first >= 0xfe80 && first <= 0xfebf) ||
    (first >= 0xfc00 && first <= 0xfdff) ||
    first >= 0xff00
  );
}

export type IpLiteral =
  | readonly [number, number, number, number]
  | readonly number[];

function parseIpLiteral(host: string): IpLiteral | undefined {
  if (host.includes(".")) {
    const v4 = parseIpv4(host);
    if (v4) return v4;
  }
  return parseIpv6(host);
}

function ipIsReserved(literal: IpLiteral): boolean {
  return literal.length === 4
    ? ipv4IsReserved(literal as Ipv4)
    : ipv6IsReserved(literal);
}

export function endpointHostIsPublicSync(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const literal = parseIpLiteral(url.hostname.replace(/^\[|\]$/gu, ""));
  return !(literal !== undefined && ipIsReserved(literal));
}

export async function assertPublicPushEndpoint(
  endpoint: string
): Promise<void> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("push endpoint is not a valid URL");
  }
  if (url.protocol !== "https:")
    throw new Error("push endpoint must use https");
  if (url.username || url.password)
    throw new Error("push endpoint must not embed credentials");
  const bareHost = url.hostname.replace(/^\[|\]$/gu, "");
  const literal = parseIpLiteral(bareHost);
  if (literal !== undefined) {
    if (ipIsReserved(literal))
      throw new Error(
        `push endpoint ${bareHost} is a reserved-range IP literal`
      );
    return;
  }
  let records: Array<{ address: string }> | undefined;
  try {
    records = await dns.lookup(bareHost, { all: true });
  } catch {
    records = undefined;
  }
  if (!records || records.length === 0)
    throw new Error(`push endpoint host ${bareHost} does not resolve`);
  for (const record of records) {
    const resolved = parseIpLiteral(record.address);
    if (resolved !== undefined && ipIsReserved(resolved))
      throw new Error(
        `push endpoint host ${bareHost} resolves to a reserved-range address (${record.address})`
      );
  }
}
