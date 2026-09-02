/** Push-endpoint SSRF guard (#865): the gateway replays a POST to every registered endpoint on each vault commit, so an endpoint pointing at loopback/LAN is blind SSRF replayed from the gateway host. Every registered endpoint must be https, credential-free, and resolve to public internet space (IP-literal or DNS), fail-closed. Send-time rechecks only IP literals — a name public at registration that later rebinds to loopback would still wake (residual in the #865 receipt). */

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

/** Reserved per #865: 0/8, RFC1918, loopback 127/8, link-local 169.254/16 (covers cloud-metadata 169.254.169.254), CGNAT 100.64/10, 192.0.0.0/24, Class E 240/4. */
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

/** Parse an IPv6 literal (with optional embedded IPv4 tail) to 8 groups. */
function parseIpv6(text: string): readonly number[] | undefined {
  // A zone index is never a routable push target — refuse by "unparseable".
  const embedded = /(?:^|:)(?<tail>\d{1,3}(?:\.\d{1,3}){3})$/u.exec(text);
  let rest = text;
  if (embedded) {
    const v4 = parseIpv4(embedded.groups!.tail!);
    if (!v4) return undefined;
    // Dotted tail → two hextexts so the "::" grammar sees pure hex groups.
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

/** IPv6 reserved set (#865): ::, ::/96 (IPv4-embedded, incl. IPv4-mapped ::ffff:0:0/96 — a mapped literal is never a clean push target), NAT64 64:ff9b::/96, link-local fe80::/10, unique-local fc00::/7, multicast ff00::/8. */
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

/** Send-time sync backstop (#865): refuse obvious reserved-range IP literals and non-https schemes. Hostnames are not re-resolved here — DNS on every vault commit would put a network round-trip on the wake path, and a name public at registration can rebind to loopback later (DNS-rebinding TOCTOU). */
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

/** Registration-time check (#865): throws a device-readable reason; the route maps every throw to 400 invalid_push_registration. */
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
