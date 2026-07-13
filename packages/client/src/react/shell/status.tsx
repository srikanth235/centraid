import type { JSX } from 'react';
import Icon from '../ui/Icon.js';
import emptyCss from '../styles/pageEmpty.module.css';
import au from '../styles/automation.module.css';

// Loading + empty/error affordances the vanilla shell rendered inline
// (`cd-au-loading` line, `renderSimpleEmpty` → `cd-page-empty`). Kept as plain
// global classes (shared chrome, already in styles.css).

export function PageLoading({ label }: { label: string }): JSX.Element {
  return <div className={au.auLoading}>{label}</div>;
}

export function PageEmpty({ message }: { message: string }): JSX.Element {
  return (
    <div className={emptyCss.pageEmpty}>
      <div className={emptyCss.pageEmptyIcon}>
        <Icon name="Sparkle" size={22} />
      </div>
      <div className={emptyCss.pageEmptyText}>{message}</div>
    </div>
  );
}
