const WRAP_COLUMN = 80;

/**
 * JSON in oxfmt's shape, so a scanner's `--write` leaves a tree `format:check`
 * passes without shelling out to the formatter. `JSON.stringify(…, 2)` differs
 * from oxfmt in exactly one place: an array whose elements are all numbers is
 * FILLED (as many per line as fit in 80 columns) rather than one per line. The
 * comment-density pins are 3,600 such arrays, which is why this exists.
 */
export function serializeLedger(value: unknown): string {
  return `${render(value, 0, 0)}\n`;
}

function render(value: unknown, indent: number, column: number): string {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 2);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((item) => typeof item === "number")) {
      const single = `[${value.join(", ")}]`;
      if (column + single.length <= WRAP_COLUMN) return single;
      return `[\n${fill(value.map(String), inner)}\n${pad}]`;
    }
    const items = value.map(
      (item) => `${inner}${render(item, indent + 2, inner.length)}`
    );
    return `[\n${items.join(",\n")}\n${pad}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const items = entries.map(([key, child], index) => {
      const head = `${inner}${JSON.stringify(key)}: `;
      // The trailing comma counts toward the 80-column budget, so all but the
      // last entry get one column less to fit a filled array on one line.
      const comma = index === entries.length - 1 ? 0 : 1;
      return `${head}${render(child, indent + 2, head.length + comma)}`;
    });
    return `{\n${items.join(",\n")}\n${pad}}`;
  }
  return JSON.stringify(value);
}

/** As many numbers per line as fit in 80 columns — oxfmt's array fill. */
function fill(parts: string[], pad: string): string {
  const lines: string[] = [];
  let line = "";
  for (const [index, part] of parts.entries()) {
    const piece = index === parts.length - 1 ? part : `${part},`;
    const next = line ? `${line} ${piece}` : `${pad}${piece}`;
    if (line && next.length > WRAP_COLUMN) {
      lines.push(line);
      line = `${pad}${piece}`;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}
