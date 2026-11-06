#!/usr/bin/env node
// An offline gallery of the unmodified simulator/emulator captures and their
// actual assertions. Failed and incomplete runs must remain visibly distinct.
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import nodePath from "node:path";

const { join, relative } = nodePath;

const [platform, directory] = process.argv.slice(2);
if (!["ios", "android"].includes(platform) || !directory) {
  throw new Error("usage: visual-report.mjs ios|android ARTIFACT_DIRECTORY");
}
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const images = (folder) =>
  existsSync(folder)
    ? readdirSync(folder, { withFileTypes: true })
        .flatMap((item) =>
          item.isDirectory()
            ? images(join(folder, item.name))
            : item.name.endsWith(".png")
              ? [join(folder, item.name)]
              : []
        )
        .sort()
    : [];
const outcomes = join(directory, "outcomes.tsv");
const cases = (
  existsSync(outcomes) ? readFileSync(outcomes, "utf8").trim() : ""
)
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [profile, name, passed] = line.split("\t");
    const folder = join(directory, profile, name);
    return {
      profile,
      name,
      passed: passed === "1",
      screenshots: images(join(folder, "screenshots")).map((path) =>
        relative(directory, path)
      ),
      failure: existsSync(join(folder, "failure.png"))
        ? `${profile}/${name}/failure.png`
        : null,
      log: `${profile}/${name}/maestro.log`,
      results: `${profile}/${name}/results.xml`,
    };
  });
const expected = platform === "ios" ? 70 : 61;
const passed = cases.filter((item) => item.passed).length;
const status =
  cases.length === expected && passed === expected
    ? "PASS"
    : "FAIL / INCOMPLETE";
const summary = `${platform}: ${status} — ${passed}/${expected} asserted captures passed`;
const limitations =
  "Public demo vault, rebuilt native core. Light/dark at default and largest text. " +
  (platform === "ios"
    ? "Base Health captures show Connect; a separate final phase uses HealthSeeder and the native permission sheet to capture Summary and a steps chart. "
    : "Health shows Connect because this fixture has no health records; Android health charts are not captured. ") +
  "Locker stays locked. " +
  "Chat shows real model setup; these captures do not exercise model inference or physical devices. " +
  "A final interaction adds two reminders with Return without refocusing the field. " +
  "Assertions establish the intended screen and content; inspect the images for clipping, contrast and spacing.";
const manifest = {
  platform,
  revision: process.env.GITHUB_SHA ?? null,
  status,
  expected,
  completed: cases.length,
  passed,
  profiles: {
    "light-default": {
      appearance: "light",
      text: platform === "ios" ? "large" : "1.0",
    },
    "dark-default": {
      appearance: "dark",
      text: platform === "ios" ? "large" : "1.0",
    },
    "light-largest": {
      appearance: "light",
      text:
        platform === "ios" ? "accessibility-extra-extra-extra-large" : "2.0",
    },
    "dark-largest": {
      appearance: "dark",
      text:
        platform === "ios" ? "accessibility-extra-extra-extra-large" : "2.0",
    },
  },
  limitations,
  cases,
};
writeFileSync(
  join(directory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);
const sections = cases
  .map((item) => {
    const paths = [
      ...item.screenshots,
      ...(item.failure ? [item.failure] : []),
    ];
    return (
      `<section><h2>${escape(item.profile)} / ${escape(item.name)} — ${item.passed ? "PASS" : "FAIL"}</h2>` +
      `<p><a href="${escape(item.log)}">Maestro log</a> · <a href="${escape(item.results)}">JUnit results</a></p><div class="images">` +
      paths
        .map(
          (path) =>
            `<a href="${escape(path)}"><img loading="lazy" src="${escape(path)}" alt="${escape(path)}"></a>`
        )
        .join("") +
      "</div></section>"
    );
  })
  .join("\n");
writeFileSync(
  join(directory, "index.html"),
  `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(summary)}</title>
<style>body{font:16px system-ui,sans-serif;margin:24px;background:#eee;color:#111}h1{font-size:24px}h2{font-size:18px}.images{display:flex;gap:16px;flex-wrap:wrap}img{max-width:360px;width:100%;height:auto}section{margin:32px 0;padding:16px;background:white}a{color:#1648ae}</style>
<h1>${escape(summary)}</h1><p>${escape(limitations)}</p><p>Revision: ${escape(manifest.revision ?? "local")}</p>
<p><a href="manifest.json">Capture manifest</a> · <a href="seed.log">Fixture seed log</a></p>${sections}</html>\n`
);
const markdown =
  `### ${summary}\n\n${limitations}\n\nDownload the \`${platform}-visual-verification\` artifact and open \`index.html\` for the gallery, logs and JUnit results.\n\n` +
  "| Profile | Screen | Result |\n| --- | --- | --- |\n" +
  cases
    .map(
      (item) =>
        `| ${item.profile} | ${item.name} | ${item.passed ? "PASS" : "FAIL"} |`
    )
    .join("\n") +
  "\n";
writeFileSync(join(directory, "summary.md"), markdown);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
console.log(summary);
