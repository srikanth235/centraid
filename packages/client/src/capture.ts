export type CaptureKind = "task" | "expense" | "note" | "event";

export interface CapturePreview {
  kind: CaptureKind;
  confidence: "deterministic" | "delegate" | "needs-review";
  title: string;
  body: string;
  amountMinor?: number;
  currency?: string;
  startsAt?: string;
  durationMinutes?: number;
  sourceUrl?: string;
}

const MONEY =
  /(?:^|\s)(?<symbol>[$€£₹])\s*(?<amount>\d+(?:[.,]\d{1,2})?)(?:\s|$)/u;
const EVENT_WORDS =
  /\b(?:meeting|appointment|call|event|schedule|lunch|dinner)\b/iu;
const TASK_WORDS =
  /^(?:todo|task|remember to|remind me to|buy|call|email|send|finish|submit|pick up)\b/iu;

const CURRENCY_BY_SYMBOL: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "₹": "INR",
};

function cleanTitle(text: string): string {
  const first = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  const title = (first ?? "Untitled capture")
    .replace(/^(?:todo|task)\s*[:-]?\s*/iu, "")
    .trim();
  return title.length <= 100 ? title : `${title.slice(0, 99).trimEnd()}…`;
}

function parseMoney(text: string): {
  amountMinor: number;
  currency: string;
} | null {
  const match = MONEY.exec(text);
  const symbol = match?.groups?.symbol;
  const amount = match?.groups?.amount;
  if (!symbol || !amount) return null;
  const numeric = Number(amount.replace(",", "."));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return {
    amountMinor: Math.round(numeric * 100),
    currency: CURRENCY_BY_SYMBOL[symbol] ?? "USD",
  };
}

function parseEventStart(text: string, now: Date): string | undefined {
  const iso =
    /\b(?<date>\d{4}-\d{2}-\d{2})(?:[ T](?<hour>\d{1,2})(?::(?<minute>\d{2}))?)?\b/u.exec(
      text
    );
  if (iso?.groups?.date) {
    const [hour, minute] = [
      Number(iso.groups.hour ?? 9),
      Number(iso.groups.minute ?? 0),
    ];
    const local = new Date(`${iso.groups.date}T00:00:00`);
    local.setHours(hour, minute, 0, 0);
    return Number.isNaN(local.getTime()) ? undefined : local.toISOString();
  }
  const relative =
    /\b(?<day>today|tomorrow)(?:\s+at)?\s+(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>am|pm)?\b/iu.exec(
      text
    );
  const day = relative?.groups?.day;
  const hourValue = relative?.groups?.hour;
  if (!day || !hourValue) return undefined;
  const start = new Date(now);
  if (day.toLowerCase() === "tomorrow") start.setDate(start.getDate() + 1);
  let hour = Number(hourValue);
  const meridiem = relative.groups?.meridiem?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  start.setHours(hour, Number(relative.groups?.minute ?? 0), 0, 0);
  return start.toISOString();
}

/**
 * Fast, offline-first capture routing. Only high-signal phrases commit to a
 * destination automatically; everything else remains a reviewable note-shaped
 * draft while the caller asks a bounded delegate turn for a second opinion.
 */
export function classifyCapture(raw: string, now = new Date()): CapturePreview {
  const body = raw.replace(/\s+/gu, " ").trim();
  const sourceUrl = /\bhttps?:\/\/[^\s]+/iu.exec(body)?.[0];
  const money = parseMoney(body);
  const startsAt = parseEventStart(body, now);
  if (money && /\b(?:spent|paid|expense|cost|receipt|split)\b/iu.test(body)) {
    return {
      kind: "expense",
      confidence: "deterministic",
      title: cleanTitle(body.replace(MONEY, " ")),
      body,
      ...money,
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  }
  if (startsAt && EVENT_WORDS.test(body)) {
    return {
      kind: "event",
      confidence: "deterministic",
      title: cleanTitle(body),
      body,
      startsAt,
      durationMinutes: 60,
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  }
  if (TASK_WORDS.test(body)) {
    return {
      kind: "task",
      confidence: "deterministic",
      title: cleanTitle(body),
      body,
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  }
  if (sourceUrl || raw.includes("\n") || body.length > 140) {
    return {
      kind: "note",
      confidence: "deterministic",
      title: cleanTitle(body),
      body,
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  }
  return {
    kind: "note",
    confidence: "needs-review",
    title: cleanTitle(body),
    body,
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

/** OCR card fields shared by web CaptureScanPanel and mobile Scan. */
export function parseCard(text: string): {
  cardholder: string;
  cardNumber: string;
  expiry: string;
} {
  const cardNumber =
    text.match(/\b(?:\d[ -]*?){13,19}\b/u)?.[0]?.replace(/\D/gu, "") ?? "";
  const expiry =
    text.match(/\b(?:0[1-9]|1[0-2])\s*[/.-]\s*\d{2,4}\b/u)?.[0] ?? "";
  const cardholder =
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(
        (line) =>
          /^[\p{L}][\p{L} .'-]{2,80}$/u.test(line) &&
          !/\b(?:visa|mastercard|debit|credit)\b/iu.test(line)
      ) ?? "";
  return { cardholder, cardNumber, expiry };
}

/**
 * Minor units → localized currency. Tolerates missing/invalid ISO codes so a
 * brief or Tally row never crashes the shell (see desktop e2e currency bug).
 */
export function formatCurrencyMinor(
  minor: number | null | undefined,
  currency?: string | null
): string {
  const value = Number(minor ?? 0) / 100;
  const code =
    typeof currency === "string" && /^[A-Za-z]{3}$/u.test(currency)
      ? currency.toUpperCase()
      : "USD";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}

/** Validate the deliberately tiny JSON shape accepted from delegate fallback. */
export function applyDelegateCaptureKind(
  preview: CapturePreview,
  candidate: unknown
): CapturePreview {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !("kind" in candidate) ||
    !["task", "expense", "note", "event"].includes(
      String((candidate as { kind?: unknown }).kind)
    )
  ) {
    return preview;
  }
  const value = candidate as {
    kind: CaptureKind;
    title?: unknown;
    amountMinor?: unknown;
    startsAt?: unknown;
    durationMinutes?: unknown;
  };
  return {
    ...preview,
    kind: value.kind,
    confidence: "delegate",
    ...(typeof value.title === "string" && value.title.trim()
      ? { title: cleanTitle(value.title) }
      : {}),
    ...(typeof value.amountMinor === "number" &&
    Number.isSafeInteger(value.amountMinor) &&
    value.amountMinor > 0
      ? { amountMinor: value.amountMinor }
      : {}),
    ...(typeof value.startsAt === "string" &&
    !Number.isNaN(Date.parse(value.startsAt))
      ? { startsAt: new Date(value.startsAt).toISOString() }
      : {}),
    ...(typeof value.durationMinutes === "number" &&
    Number.isSafeInteger(value.durationMinutes) &&
    value.durationMinutes > 0
      ? { durationMinutes: value.durationMinutes }
      : {}),
  };
}
