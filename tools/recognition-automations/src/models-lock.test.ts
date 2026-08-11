import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const packageDir = path.resolve(import.meta.dirname, "..");
const lock = JSON.parse(
  readFileSync(path.join(packageDir, "models.lock.json"), "utf8")
) as {
  schemaVersion: number;
  files: Array<{
    model: string;
    path: string;
    sha256: string;
    license: string;
    url: string;
  }>;
};
const licenses = readFileSync(path.join(packageDir, "LICENSES.md"), "utf8");

describe("[law:enrichment-model-lock]", () => {
  it("pins every downloaded file by digest and permissive licence", () => {
    expect(lock.schemaVersion).toBe(1);
    expect(lock.files).toHaveLength(21);
    expect(new Set(lock.files.map((file) => file.path)).size).toBe(21);
    for (const file of lock.files) {
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(["Apache-2.0", "MIT"]).toContain(file.license);
      expect(file.url).toMatch(/^https:\/\//u);
      expect(file.path).not.toContain("..");
    }
  });

  it("pins the native runtime packages exactly too", () => {
    const runtime = JSON.parse(
      readFileSync(path.join(packageDir, "runtime/package.json"), "utf8")
    ) as { dependencies: Record<string, string> };
    expect(runtime.dependencies).toStrictEqual({
      "@ffmpeg-installer/ffmpeg": "1.1.0",
      "@huggingface/transformers": "3.7.5",
      "@napi-rs/canvas": "1.0.2",
      "onnxruntime-node": "1.27.0",
      "pdfjs-dist": "6.2.108",
      sharp: "0.35.3",
    });
  });

  it("records every pinned model/version and licence in LICENSES.md", () => {
    for (const file of lock.files) {
      expect(licenses).toContain(`\`${file.model}\``);
      expect(licenses).toContain(`| ${file.license} |`);
    }
  });
});
