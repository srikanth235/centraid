import { useMemo, useState } from "react";

import { parseWikiLinks } from "../commonmark.ts";
import type { Note, NoteReference } from "../types.ts";

import styles from "./WikiLinks.module.css";

interface LinkTarget {
  type: string;
  id: string;
  title: string;
  subtitle?: string;
  app?: string;
}

function titleOf(reference: NoteReference): string {
  return reference.card.title?.trim() || `${reference.card.type} (unavailable)`;
}

export function WikiLinks({
  note,
  body,
  onLink,
}: {
  note: Note;
  body: string;
  onLink: (
    target: LinkTarget,
    anchor: {
      exact: string;
      prefix: string;
      suffix: string;
      start: number;
    }
  ) => Promise<void>;
}) {
  const links = useMemo(() => parseWikiLinks(body), [body]);
  const resolved = new Set(
    (note.references ?? []).map((reference) =>
      titleOf(reference).toLocaleLowerCase()
    )
  );
  const broken = links.filter(
    (token) => !resolved.has(token.label.toLocaleLowerCase())
  );
  const [active, setActive] = useState<(typeof broken)[number]>();
  const [targets, setTargets] = useState<LinkTarget[]>([]);
  const [searching, setSearching] = useState(false);

  const findTargets = async (token: (typeof broken)[number]) => {
    setActive(token);
    setSearching(true);
    try {
      const result = await window.centraid.read<{ targets?: LinkTarget[] }>({
        query: "link-targets",
        input: { term: token.label },
      });
      setTargets(
        (result.targets ?? []).filter(
          (target) =>
            !(target.type === "knowledge.note" && target.id === note.note_id)
        )
      );
    } finally {
      setSearching(false);
    }
  };

  if (
    links.length === 0 &&
    (note.references?.length ?? 0) === 0 &&
    (note.backlinks?.length ?? 0) === 0
  )
    return null;

  return (
    <section className={styles.wrap} aria-label="Links and backlinks">
      <h3>Links</h3>
      <div className={styles.chips}>
        {(note.references ?? []).map((reference) => (
          <span className={styles.chip} key={reference.link_id}>
            {titleOf(reference)}
            <small>{reference.card.type}</small>
          </span>
        ))}
        {broken.map((token) => (
          <button
            type="button"
            className={styles.broken}
            key={`${token.start}:${token.raw}`}
            onClick={() => void findTargets(token)}
          >
            Broken: {token.label} · choose target
          </button>
        ))}
      </div>
      {active ? (
        <div className={styles.powerbox} aria-label="Wikilink targets">
          <strong>Link “{active.label}” to…</strong>
          {searching ? <output>Searching…</output> : null}
          {!searching && targets.length === 0 ? (
            <output>No matching entity — keep the broken link as text.</output>
          ) : null}
          {targets.map((target) => (
            <button
              type="button"
              key={`${target.type}:${target.id}`}
              onClick={() => {
                const prefix = body.slice(
                  Math.max(0, active.start - 32),
                  active.start
                );
                const suffix = body.slice(active.end, active.end + 32);
                void onLink(target, {
                  exact: active.raw,
                  prefix,
                  suffix,
                  start: active.start,
                }).then(() => {
                  setActive(undefined);
                  setTargets([]);
                });
              }}
            >
              <span>{target.title}</span>
              <small>
                {target.app ?? target.type}
                {target.subtitle ? ` · ${target.subtitle}` : ""}
              </small>
            </button>
          ))}
        </div>
      ) : null}
      {(note.backlinks?.length ?? 0) > 0 ? (
        <>
          <h3>Backlinks</h3>
          <div className={styles.chips}>
            {note.backlinks?.map((reference) => (
              <span className={styles.chip} key={reference.link_id}>
                {titleOf(reference)}
                <small>{reference.card.type}</small>
              </span>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
