import type { JSX } from 'react';
import Icon from '../ui/Icon.js';

// Loading + empty/error affordances the vanilla shell rendered inline
// (`cd-au-loading` line, `renderSimpleEmpty` → `cd-page-empty`). Kept as plain
// global classes (shared chrome, already in styles.css).

export function PageLoading({ label }: { label: string }): JSX.Element {
  return <div className="cd-au-loading">{label}</div>;
}

export function PageEmpty({ message }: { message: string }): JSX.Element {
  return (
    <div className="cd-page-empty">
      <div className="cd-page-empty-icon">
        <Icon name="Sparkle" size={22} />
      </div>
      <div className="cd-page-empty-text">{message}</div>
    </div>
  );
}
