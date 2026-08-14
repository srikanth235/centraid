import type { JSX, ReactNode } from "react";

import { apps, icons } from "@centraid/design";
import type { IconName } from "@centraid/design";

import AppCard from "./AppCard.js";
import BarsBlock from "./BarsBlock.js";
import Button from "./Button.js";
import ChipsBlock from "./ChipsBlock.js";
import DocTable from "./DocTable.js";
import EmptyBlock from "./EmptyBlock.js";
import Icon from "./Icon.js";
import Logo from "./Logo.js";
import NoteBlock from "./NoteBlock.js";
import PanelBlock from "./PanelBlock.js";
import RowsBlock from "./RowsBlock.js";
import SectionBlock from "./SectionBlock.js";

const SAMPLE_ICONS = Object.keys(icons).slice(0, 12) as IconName[];

/** Sample data for the block kit — the blocks themselves ship no copy. */
const GALLERY_BARS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  fail: day === 3 ? 8 : 0,
  id: `day-${day}`,
  label: `${day === 3 ? "1 failed · " : ""}day ${day + 1}`,
  ok: 34 + ((day * 37) % 54),
}));

function Section({
  title,
  children,
  stack,
}: {
  title: string;
  children: ReactNode;
  /** Blocks are full-width and read top to bottom, unlike the control row. */
  stack?: boolean;
}): JSX.Element {
  return (
    <section style={{ marginBottom: 36 }}>
      <h2
        style={{
          color: "var(--text-faint, #6b7280)",
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "0.08em",
          margin: "0 0 14px",
          textTransform: "uppercase",
        }}
      >
        {title}
      </h2>
      <div
        style={{
          alignItems: stack ? "stretch" : "center",
          display: "flex",
          flexDirection: stack ? "column" : "row",
          flexWrap: stack ? "nowrap" : "wrap",
          gap: 16,
        }}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * Component gallery — the single preview surface for the local UI library.
 * Rendered both by the in-shell coexistence island (Phase 0 proof) and, once
 * synced, by claude.ai/design (Phase 2). Every primitive is drawn from the
 * real design tokens so the gallery matches the shell exactly.
 */
export default function Gallery(): JSX.Element {
  return (
    <div
      style={{
        color: "var(--text, #141820)",
        fontFamily: "var(--font-ui, system-ui, sans-serif)",
        margin: "0 auto",
        maxWidth: 880,
        padding: "32px 28px 64px",
      }}
    >
      <header
        style={{
          alignItems: "center",
          display: "flex",
          gap: 12,
          marginBottom: 32,
        }}
      >
        <Logo size={36} />
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>desktop-ui</div>
          <div style={{ color: "var(--text-faint, #6b7280)", fontSize: 13 }}>
            React DOM primitives · pixel-identical to the vanilla shell
          </div>
        </div>
      </header>

      <Section title="Buttons">
        <Button label="Primary" variant="primary" icon="Bolt" />
        <Button label="Secondary" variant="secondary" />
        <Button label="Quiet" variant="quiet" />
        {/* Outlined `net`, never a fill — the one exception to the no-hue
            rule, and it still reads as an outline. */}
        <Button label="Destructive" variant="destructive" />
        <Button label="Disabled" variant="primary" disabled />
      </Section>

      <Section stack title="Blocks · section, rows, note">
        <SectionBlock label="Waiting on you" meta="showing 3 of 12" />
        <RowsBlock
          rows={[
            {
              action: { label: "Review", onClick: () => {} },
              id: "r1",
              meta: "Waiting",
              sub: "Staged 08:41 · nothing has been sent",
              title: "Outbound email to tom@pemberton.example",
            },
            {
              action: { label: "Re-authorize", onClick: () => {} },
              id: "r2",
              meta: "Expiring",
              net: true,
              sub: "Expires in 6 days",
              title: "Re-authorize Drive",
            },
            {
              action: { label: "Deny", onClick: () => {} },
              dangerous: true,
              id: "r3",
              sub: "Nothing is sent. The automation is told it was refused.",
              title: "Deny this write",
            },
            {
              action: { label: "Resume", onClick: () => {} },
              id: "r4",
              meta: "Paused",
              off: true,
              title: "Tidy downloads",
            },
          ]}
        />
        <NoteBlock>
          A standing grant skips this page for one narrow thing. Revoking one
          takes effect on the next run.
        </NoteBlock>
      </Section>

      <Section stack title="Blocks · panel and facts">
        <PanelBlock
          action={{
            filled: true,
            label: "Approve and send",
            onClick: () => {},
          }}
          action2={{ label: "Edit and approve", onClick: () => {} }}
          body="Tom — the survey arrived on Tuesday and it is better than we feared."
          eyebrow="Outbound email · staged by the assistant · 08:41"
          facts={[
            { key: "to", mono: true, value: "tom@pemberton.example" },
            {
              key: "nothing has been sent",
              net: true,
              value: "approving sends it immediately",
            },
          ]}
          quote
          title="The survey came back"
        />
        <PanelBlock
          action={{ label: "Try again", onClick: () => {} }}
          body="The gateway answered, but the queue that holds staged writes did not. Nothing has been approved or denied in the meantime."
          eyebrow="Could not reach the consent store"
          tone="net"
          wide
        />
      </Section>

      <Section stack title="Blocks · chips and empties">
        <ChipsBlock
          ariaLabel="Filters"
          chips={[
            { id: "all", label: "Everything", on: true },
            { id: "risk", label: "High risk" },
            { id: "auth", label: "Authorization" },
          ]}
          onPick={() => {}}
        />
        <ChipsBlock
          ariaLabel="Window"
          chips={[
            { id: "7", label: "7 days", on: true },
            { id: "30", label: "30 days" },
            { id: "90", label: "90 days" },
          ]}
          mono
          onPick={() => {}}
        />
        <EmptyBlock
          action={{ label: "Pair a device", onClick: () => {} }}
          body="This host is the only copy. Pair a second device and the vault has somewhere to go."
          title="Nothing has a copy yet"
        />
        <EmptyBlock
          action={{ label: "Review history", onClick: () => {} }}
          body="Nothing is waiting on you."
          routine
          title="Nothing to decide"
        />
      </Section>

      <Section stack title="Blocks · records table">
        <DocTable
          ariaLabel="Records"
          caption="The first 3 of 1,908, newest first. The table scrolls rather than pages."
          headers={{ kind: "Kind", record: "Record", written: "Written" }}
          menu={[
            { icon: "Eye", id: "open", label: "Open the record" },
            { icon: "Pencil", id: "edit", label: "Edit" },
            "sep",
            { danger: true, icon: "Trash", id: "delete", label: "Delete" },
          ]}
          rows={[
            {
              icon: "FileEdit",
              id: "d1",
              kind: "pdf",
              title: "Survey — 14 Bridge Street",
              written: "12 Aug 2026",
            },
            {
              icon: "Image",
              id: "d2",
              kind: "heic",
              title: "IMG_4417",
              written: "11 Aug 2026",
            },
            {
              icon: "Receipt",
              id: "d3",
              kind: "csv",
              title: "Statement — July",
              written: "02 Aug 2026",
            },
          ]}
        />
      </Section>

      <Section stack title="Blocks · runs chart">
        <BarsBlock
          ariaLabel="Runs per day over the last 7 days"
          axis={["7 days ago", "halfway", "today"]}
          bars={GALLERY_BARS}
          legend={{ fail: "failed", ok: "succeeded" }}
        />
      </Section>

      <Section title="Icons">
        {SAMPLE_ICONS.map((name) => (
          <span
            key={name}
            title={name}
            style={{
              color: "var(--text-soft, #374151)",
              display: "inline-flex",
            }}
          >
            <Icon name={name} size={22} />
          </span>
        ))}
      </Section>

      <Section title="Logo">
        <Logo size={28} />
        <Logo size={40} />
        <Logo size={56} />
      </Section>

      <Section title="App cards">
        {apps.slice(0, 4).map((app, i) => (
          <div key={app.id} style={{ width: 240 }}>
            <AppCard
              app={app}
              variant="gradient"
              tone={i === 0 ? "new" : i === 1 ? "draft" : null}
              stamp={i === 1 ? "saved" : "2h ago"}
            />
          </div>
        ))}
      </Section>
    </div>
  );
}
