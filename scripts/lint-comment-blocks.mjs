#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import {
  ROOT,
  commentRanges,
  loadBaseline,
  trackedFiles,
} from "./check-comment-density-ratchet.mjs";

export const BLOCK_LIMIT = 10;
export const HEADER_LIMIT = 15;

export function commentBlocks(text, fileName) {
  const { sourceFile, ranges } = commentRanges(text, fileName);
  const lines = text.split("\n");
  const lineOf = (pos) => sourceFile.getLineAndCharacterOfPosition(pos).line;
  const firstCodeStart = sourceFile.getStart(sourceFile);
  const blocks = [];
  let run = null;
  const flush = () => {
    if (run) blocks.push(run);
    run = null;
  };
  for (const range of ranges) {
    const first = lineOf(range.pos);
    const last = lineOf(range.end);
    if (range.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      flush();
      blocks.push({
        pos: range.pos,
        line: first + 1,
        lines: last - first + 1,
        header: range.pos < firstCodeStart,
      });
      continue;
    }
    const contiguous =
      run !== null &&
      lines.slice(run.lastLine + 1, first).every((line) => line.trim() === "");
    if (!contiguous) {
      flush();
      run = {
        pos: range.pos,
        line: first + 1,
        lines: 0,
        header: range.pos < firstCodeStart,
        lastLine: first,
      };
    }
    run.lines += last - first + 1;
    run.lastLine = last;
  }
  flush();
  return blocks;
}

export function lintCommentBlocks({ root = ROOT, files, allowlist = {} } = {}) {
  const findings = [];
  for (const rel of files ?? trackedFiles(root)) {
    if (allowlist[rel]) continue;
    const text = readFileSync(path.join(root, rel), "utf8");
    for (const block of commentBlocks(text, rel)) {
      const limit = block.header ? HEADER_LIMIT : BLOCK_LIMIT;
      if (block.lines <= limit) continue;
      findings.push(
        `${rel}:${block.line}  ${block.lines}-line block (limit ${limit})`
      );
    }
  }
  return findings;
}

function main() {
  const findings = lintCommentBlocks({
    root: ROOT,
    allowlist: loadBaseline(ROOT).allowlist ?? {},
  });
  for (const finding of findings) console.log(finding);
  console.log(
    findings.length === 0
      ? "lint-comment-blocks: clean — every block inside its bound"
      : `lint-comment-blocks: ${findings.length} block(s) over bound — split the block or cut it to the obligation it states (warn-only)`
  );
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
