import type { JSX, ReactNode } from 'react';
import { apps, icons } from '@centraid/design-tokens';
import type { IconName } from '@centraid/design-tokens';
import AppCard from './AppCard.js';
import Button from './Button.js';
import Icon from './Icon.js';
import Logo from './Logo.js';

const SAMPLE_ICONS = Object.keys(icons).slice(0, 12) as IconName[];

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section style={{ marginBottom: 36 }}>
      <h2
        style={{
          color: 'var(--ink-3, #6b7280)',
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '0.08em',
          margin: '0 0 14px',
          textTransform: 'uppercase',
        }}
      >
        {title}
      </h2>
      <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 16 }}>
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
        color: 'var(--ink, #141820)',
        fontFamily: 'var(--font-ui, system-ui, sans-serif)',
        margin: '0 auto',
        maxWidth: 880,
        padding: '32px 28px 64px',
      }}
    >
      <header style={{ alignItems: 'center', display: 'flex', gap: 12, marginBottom: 32 }}>
        <Logo size={36} />
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>desktop-ui</div>
          <div style={{ color: 'var(--ink-3, #6b7280)', fontSize: 13 }}>
            React DOM primitives · pixel-identical to the vanilla shell
          </div>
        </div>
      </header>

      <Section title="Buttons">
        <Button label="Primary" variant="primary" icon="Bolt" />
        <Button label="Soft" variant="soft" />
        <Button label="Ghost" variant="ghost" />
        <Button label="Disabled" variant="primary" disabled />
      </Section>

      <Section title="Icons">
        {SAMPLE_ICONS.map((name) => (
          <span
            key={name}
            title={name}
            style={{ color: 'var(--ink-2, #374151)', display: 'inline-flex' }}
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
              tone={i === 0 ? 'new' : i === 1 ? 'draft' : null}
              stamp={i === 1 ? 'saved' : '2h ago'}
            />
          </div>
        ))}
      </Section>
    </div>
  );
}
