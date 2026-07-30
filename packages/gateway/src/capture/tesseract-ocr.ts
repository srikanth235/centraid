import { spawn } from "node:child_process";

export interface OcrExtraction {
  text: string;
  confidence: number;
  engine: "tesseract";
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Parse Tesseract's stable TSV output while retaining line boundaries. */
export function parseTesseractTsv(raw: string): OcrExtraction {
  const words: Array<{
    lineKey: string;
    text: string;
    confidence: number;
  }> = [];
  for (const row of raw.split(/\r?\n/u).slice(1)) {
    const fields = row.split("\t");
    if (fields.length < 12 || fields[0] !== "5") continue;
    const text = fields.slice(11).join("\t").trim();
    const confidence = Number(fields[10]);
    if (!text || !Number.isFinite(confidence) || confidence < 0) continue;
    words.push({
      lineKey: `${fields[1]}:${fields[2]}:${fields[3]}:${fields[4]}`,
      text,
      confidence,
    });
  }
  const lines: string[] = [];
  let currentKey = "";
  for (const word of words) {
    if (word.lineKey === currentKey) {
      lines[lines.length - 1] = `${lines.at(-1)} ${word.text}`;
    } else {
      lines.push(word.text);
      currentKey = word.lineKey;
    }
  }
  return {
    text: lines.join("\n"),
    confidence:
      words.length > 0
        ? words.reduce((sum, word) => sum + word.confidence, 0) /
          words.length /
          100
        : 0,
    engine: "tesseract",
  };
}

/**
 * Bounded, shell-free gateway backstop for browsers and low-capability devices.
 * It is opt-in through CENTRAID_TESSERACT_PATH; self-hosters without the binary
 * get an honest 503 instead of uploading content to a third party.
 */
export async function recognizeWithTesseract(
  input: Buffer,
  executable = process.env.CENTRAID_TESSERACT_PATH?.trim(),
  timeoutMs = 60_000
): Promise<OcrExtraction> {
  if (!executable)
    throw new Error(
      "Gateway OCR is not configured. Set CENTRAID_TESSERACT_PATH to a Tesseract-compatible executable."
    );
  return new Promise<OcrExtraction>((resolve, reject) => {
    const child = spawn(executable, ["stdin", "stdout", "--psm", "6", "tsv"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Gateway OCR timed out."));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        reject(new Error("Gateway OCR output exceeded the 4 MB limit."));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((sum, item) => sum + item.length, 0) < 4_096)
        stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `Gateway OCR failed${stderr.length ? `: ${Buffer.concat(stderr).toString("utf8").trim()}` : "."}`
          )
        );
        return;
      }
      resolve(parseTesseractTsv(Buffer.concat(stdout).toString("utf8")));
    });
    child.stdin.end(input);
  });
}
