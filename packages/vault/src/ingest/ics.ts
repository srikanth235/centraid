export interface IcsEvent {
  uid: string;
  summary: string;
  description: string | null;
  dtstart: string;
  dtend: string | null;
  startTz: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  rrule: string | null;
}

const MAX_ICS_LINES = 500_000;
const MAX_ICS_LINE_CHARS = 1024 * 1024;

function unfold(text: string): string[] {
  const lines = text
    .replace(/\r\n[ \t]/gu, "")
    .replace(/\n[ \t]/gu, "")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  if (lines.length > MAX_ICS_LINES)
    throw new Error(`ICS exceeds ${MAX_ICS_LINES} unfolded lines`);
  if (lines.some((line) => line.length > MAX_ICS_LINE_CHARS))
    throw new Error(`ICS line exceeds ${MAX_ICS_LINE_CHARS} characters`);
  return lines;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): Prop | null {
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = left.split(";");
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return { name: (name ?? "").toUpperCase(), params, value };
}

const ICS_DATE_RE = /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})$/u;
const ICS_DATE_TIME_RE =
  /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})T(?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2})(?<zulu>Z?)$/u;

function toIso(value: string): string {
  const dateOnly = ICS_DATE_RE.exec(value);
  if (dateOnly) {
    const d = dateOnly.groups!;
    return `${d.year}-${d.month}-${d.day}`;
  }
  const dt = ICS_DATE_TIME_RE.exec(value);
  if (!dt) return value; // pass through anything exotic, unmangled
  const t = dt.groups!;
  const zulu = t.zulu === "Z" ? "Z" : "";
  return `${t.year}-${t.month}-${t.day}T${t.hour}:${t.minute}:${t.second}${zulu}`;
}

const TEXT_UNESCAPES: Record<string, string> = {
  "\\n": "\n",
  "\\N": "\n",
  "\\,": ",",
  "\\;": ";",
  "\\\\": "\\",
};

function unescapeText(value: string): string {
  return value.replace(/\\[nN,;\\]/gu, (m) => TEXT_UNESCAPES[m] ?? m);
}

export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let current: Partial<IcsEvent> | null = null;
  for (const line of unfold(text)) {
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === "BEGIN" && prop.value.toUpperCase() === "VEVENT") {
      if (current) throw new Error("ICS contains nested VEVENT records");
      current = {
        status: "confirmed",
        description: null,
        dtend: null,
        startTz: null,
        rrule: null,
      };
      continue;
    }
    if (prop.name === "END" && prop.value.toUpperCase() === "VEVENT") {
      if (current?.uid && current.summary && current.dtstart)
        events.push(current as IcsEvent);
      current = null;
      continue;
    }
    if (!current) continue;
    switch (prop.name) {
      case "UID":
        current.uid = prop.value;
        break;
      case "SUMMARY":
        current.summary = unescapeText(prop.value);
        break;
      case "DESCRIPTION":
        current.description = unescapeText(prop.value);
        break;
      case "DTSTART":
        current.dtstart = toIso(prop.value);
        current.startTz = prop.params["TZID"] ?? current.startTz;
        break;
      case "DTEND":
        current.dtend = toIso(prop.value);
        break;
      case "RRULE":
        current.rrule = prop.value;
        break;
      case "STATUS": {
        const status = prop.value.toLowerCase();
        if (
          status === "confirmed" ||
          status === "tentative" ||
          status === "cancelled"
        )
          current.status = status;
        break;
      }
      default:
        break;
    }
  }
  if (current) throw new Error("truncated ICS VEVENT");
  return events;
}
