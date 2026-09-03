import type { JSX } from "react";

import { Icon } from "../ui/index.js";

import styles from "./AutomationCompilePane.module.css";

export type ArtifactFile = "handler" | "manifest";

export interface AutomationCompileArtifactsProps {
  source: { manifest: string | null; handler: string | null } | null;
  file: ArtifactFile;
  onFile: (f: ArtifactFile) => void;
}

export default function AutomationCompileArtifacts({
  source,
  file,
  onFile,
}: AutomationCompileArtifactsProps): JSX.Element {
  const code = source
    ? file === "handler"
      ? source.handler
      : source.manifest
    : null;
  const lines = (code ?? "").split("\n");
  return (
    <div className={styles.artifacts}>
      <div
        className={styles.artifactTabs}
        role="tablist"
        aria-label="Compiled files"
      >
        {(["handler", "manifest"] as const).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={file === f}
            className={styles.artifactTab}
            data-active={String(file === f)}
            onClick={() => onFile(f)}
          >
            {f === "handler" ? "handler.js" : "automation.json"}
          </button>
        ))}
        <span className={styles.artifactSpacer} />
        <button
          type="button"
          className={styles.artifactCopy}
          disabled={!code}
          onClick={() => code && void navigator.clipboard?.writeText(code)}
        >
          <Icon name="Copy" size={11} />
          <span>Copy</span>
        </button>
      </div>
      {code ? (
        <pre className={styles.code} data-testid="compile-artifact">
          {lines.map((line, i) => (
            <div key={i} className={styles.codeLine}>
              <span className={styles.codeGutter} aria-hidden="true">
                {i + 1}
              </span>
              <code>{line || " "}</code>
            </div>
          ))}
        </pre>
      ) : (
        <p className={styles.artifactEmpty}>
          Nothing compiled yet — the plan appears here once a compile succeeds.
        </p>
      )}
    </div>
  );
}
