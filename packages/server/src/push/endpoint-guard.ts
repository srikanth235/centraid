/*
 * Push-endpoint SSRF guard (issue #865).
 *
 * A device-principal holder registers the Web-Push endpoint verbatim and the
 * gateway replays a POST to it on every vault commit — so an endpoint pointing
 * at loopback/LAN HTTPS targets is blind SSRF replayed automatically from the
 * gateway host. Every registered endpoint must resolve to public internet
 * space: https only, no credentials-in-URL, no private/loopback/link-local/
 * unique-local addresses (IP-literal OR resolved via DNS), fail-closed on
 * resolution failure.
 */

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

/**
 * The reserved ranges a push endpoint must never point at (issue #865):
 * 0.0.0.0/8, RFC1918 10/8 + 172.16/12 + 192.168/16, loopback 127/8, and
 * link-local 169.254/16.
 */
function ipv4IsReserved(parts: Ipv4): boolean {
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Parse an IPv6 literal (with optional embedded IPv4 tail) to 8 groups. */
function parseIpv6(text: string): readonly number[] | undefined {
  // A zone index is never a routable push target — refuse by "unparseable".
  const embedded = /(?:^|:)(?<tail>\d{1,3}(?:\.\d{1,3}){3})$/u.exec(text);
  let rest = text;
  if (embedded) {
    const v4 = parseIpv4(embedded.groups!.tail!);
    if (!v4) return undefined;
    // Rewrite the dotted tail as two hextexts so the "::" grammar sees pure
    // hex groups (::ffff:192.168.0.1 → ::ffff:c0a8:1).
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
  // Expand the "::" fill between head and rear.
  return [...head, ...Array.from({ length: 8 - total }, () => 0), ...rear];
}

/**
 * The IPv6 equivalents of the ipv4IsReserved ranges (issue #865): :: and ::1,
 * the whole ::/96 block whose low 32 bits embed an IPv4 address (IPv4-mapped
 * ::ffff:0:0/96 and the deprecated IPv4-compatible form), NAT64 64:ff9b::/96,
 * link-local fe80::/10, unique-local fc00::/7, and multicast ff00::/8.
 */
function ipv6IsReserved(groups: readonly number[]): boolean {
  const leadingZeros = (count: number): boolean =>
    groups.slice(0, count).every((group) => group === 0);
  if (groups.every((group) => group === 0)) return true;
  // ::/96 embeds an IPv4 address in its low 32 bits (the deprecated
  // IPv4-compatible form); ::ffff:0:0/96 is the IPv4-mapped form. Both are
  // refused outright — a mapped literal is never a clean push target.
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

/** Parse a hostname that IS an IP literal; undefined when it is a name. */
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

/**
 * Synchronous subset used at SEND time (issue #865): rows persisted before the
 * registration guard existed (or written by an older build) must not get a
 * wake POST when their endpoint is an obvious reserved-range IP literal or a
 * non-https scheme. Hostname endpoints rely on the registration-time DNS check.
 */
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

/**
 * Full registration-time check (issue #865). Throws with a device-readable
 * reason; the route maps every throw to 400 invalid_push_registration.
 */
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
  // Fail closed: a host we cannot resolve is refused, never assumed safe.
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
