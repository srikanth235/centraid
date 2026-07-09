import type { IconName } from '@centraid/design-tokens';
import { type CSSProperties, type JSX, useEffect, useRef, useState } from 'react';
import { iconSvg } from '../iconSvg.js';
import styles from './SpaceModal.module.css';
import { cx } from '../../ui/cx.js';

// The Spaces add/rename modal, ported to React (issue #325, R5) from the vanilla
// `window.Profiles.openModal`. A space IS a vault (#280); this is a name + icon +
// color + blurb form with a live switcher preview. Renders the same global
// `.cd-prof-*` chrome the vanilla emitted (already in styles.css). Gateway I/O +
// the delete flow live in the caller (SettingsRoute); this is pure presentation.

export const PROFILE_COLORS: readonly string[] = [
  '#4E68DD',
  '#E55772',
  '#7C5BD9',
  '#2EA098',
  '#5C8A4E',
  '#E89A3C',
  '#B47B3F',
  '#5C677D',
];
export const PROFILE_ICONS: readonly IconName[] = [
  'Home',
  'Bolt',
  'Sparkle',
  'Compass',
  'Book',
  'Music',
  'Gym',
  'Plant',
  'Calendar',
  'Camera',
  'Mood',
  'Gift',
];
export const DEFAULT_SPACE_ICON: IconName = 'Sparkle';

export function randomSpaceColor(): string {
  const i = Math.floor(Math.random() * PROFILE_COLORS.length);
  return PROFILE_COLORS[i] ?? PROFILE_COLORS[0] ?? '#4E68DD';
}

export interface SpaceModalInitial {
  name?: string;
  icon?: IconName;
  color?: string;
  blurb?: string;
}
export interface SpaceModalCommit {
  name: string;
  icon: IconName;
  color: string;
  blurb: string;
}
export interface SpaceModalProps {
  mode: 'add' | 'edit';
  initial: SpaceModalInitial;
  onCancel: () => void;
  onCommit: (data: SpaceModalCommit) => void;
  /** Shown as a "Delete" chip in the footer for non-primordial edit. */
  onDelete?: () => void;
}

function Avatar({ icon, color, size }: { icon: IconName; color: string; size: number }): JSX.Element {
  return (
    <span
      className="cd-prof-avatar"
      style={{ background: color, width: size, height: size } as CSSProperties}
      dangerouslySetInnerHTML={{ __html: iconSvg(icon, Math.round(size * 0.42), 1.7) }}
    />
  );
}

export default function SpaceModal({ mode, initial, onCancel, onCommit, onDelete }: SpaceModalProps): JSX.Element {
  const [name, setName] = useState(initial.name ?? '');
  const [icon, setIcon] = useState<IconName>(initial.icon ?? DEFAULT_SPACE_ICON);
  const [color, setColor] = useState(initial.color ?? PROFILE_COLORS[0]!);
  const [blurb, setBlurb] = useState(initial.blurb ?? '');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      nameRef.current?.focus();
      nameRef.current?.select();
    });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  const ready = name.trim().length > 0;
  const submit = (): void => {
    if (!ready) return;
    onCommit({ name: name.trim(), icon, color, blurb: blurb.trim() });
  };

  return (
    <div className={styles.profOverlay}>
      <button
        type="button"
        className={styles.profScrim}
        aria-label="Close"
        tabIndex={-1}
        onClick={onCancel}
      />
      <div className={styles.profModal} role="dialog" aria-modal="true">
        <div className={styles.profModalHead}>
          <span
            className={styles.profModalHeadIcon}
            dangerouslySetInnerHTML={{ __html: iconSvg('Users', 14) }}
          />
          <h2 className={styles.profModalTitle}>{mode === 'add' ? 'New profile' : 'Edit profile'}</h2>
          <button
            type="button"
            className={cx("cd-icon-btn", styles.profModalClose)}
            title="Close"
            aria-label="Close"
            onClick={onCancel}
            dangerouslySetInnerHTML={{ __html: iconSvg('X', 14) }}
          />
        </div>
        <div className={styles.profModalBody}>
          <div className={styles.profModalPreview}>
            <span className="cd-prof-modal-preview-avatar">
              <Avatar icon={icon} color={color} size={46} />
            </span>
            <div className={styles.profModalPreviewText}>
              <div className={styles.profModalPreviewName}>{name.trim() || 'Untitled'}</div>
              <div className={styles.profModalPreviewSub}>
                {blurb.trim() || 'How this profile appears in the switcher.'}
              </div>
            </div>
          </div>

          <label className={styles.profField}>
            <span className={styles.profFieldLabel}>Name</span>
            <input
              ref={nameRef}
              className={styles.profFieldInput}
              type="text"
              placeholder="e.g. Work"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </label>

          <label className={styles.profField}>
            <span className={styles.profFieldLabel}>Icon</span>
            <div className={styles.profIconGrid}>
              {PROFILE_ICONS.map((ic) => (
                <button
                  key={ic}
                  type="button"
                  className={styles.profIconBtn}
                  title={ic}
                  aria-label={ic}
                  data-selected={ic === icon ? 'true' : 'false'}
                  onClick={() => setIcon(ic)}
                  dangerouslySetInnerHTML={{ __html: iconSvg(ic, 16) }}
                />
              ))}
            </div>
          </label>

          <label className={styles.profField}>
            <span className={styles.profFieldLabel}>Color</span>
            <div className={styles.profColorRow}>
              {PROFILE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={styles.profColorBtn}
                  title={c}
                  aria-label={`Color ${c}`}
                  data-selected={c === color ? 'true' : 'false'}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </label>

          <label className={styles.profField}>
            <span className={styles.profFieldLabel}>
              Description<span className={styles.profFieldOptional}>optional</span>
            </span>
            <input
              className={styles.profFieldInput}
              type="text"
              placeholder="A short note — e.g. Focus & planning"
              value={blurb}
              onChange={(e) => setBlurb(e.target.value)}
            />
          </label>
        </div>
        <div className={styles.profModalFoot}>
          {onDelete ? (
            <button type="button" className={cx("cd-chip", styles.profModalDelete)} onClick={onDelete}>
              <span dangerouslySetInnerHTML={{ __html: iconSvg('Trash', 12) }} />
              Delete
            </button>
          ) : null}
          <span style={{ flex: 1 }} />
          <button type="button" className="cd-chip" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.profModalSave}
            disabled={!ready}
            data-enabled={ready ? 'true' : 'false'}
            onClick={submit}
          >
            {mode === 'add' ? 'Create profile' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
