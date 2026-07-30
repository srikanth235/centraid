import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { Icon } from "./Shared.tsx";

import styles from "./LockScreen.module.css";

export interface LockScreenProps {
  configured: boolean | null;
  busy: boolean;
  error: string;
  mode?: "unlock" | "item";
  onSubmit: (secret: string) => void;
  onCancel?: () => void;
}

/**
 * The only interactive subtree while Locker is locked or re-prompting.
 * Background content is inert in Chrome; this dialog also cycles Tab locally
 * and restores focus through React unmount, so keyboard users cannot escape
 * into secret-bearing controls.
 */
export function LockScreen({
  configured,
  busy,
  error,
  mode = "unlock",
  onSubmit,
  onCancel,
}: LockScreenProps) {
  const [value, setValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const descriptionId = useId();
  const setup = mode === "unlock" && configured === false;

  useEffect(() => {
    inputRef.current?.focus();
  }, [configured, mode]);

  const submit = () => {
    if (!value) {
      setLocalError("Enter your passphrase.");
      return;
    }
    if (setup && value.length < 12) {
      setLocalError("Use at least 12 characters.");
      return;
    }
    if (setup && value !== confirm) {
      setLocalError("The passphrases do not match.");
      return;
    }
    setLocalError("");
    onSubmit(value);
  };

  const trapFocus = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Escape" && onCancel && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>(
        "input,button:not([disabled])"
      ) ?? []),
    ];
    if (controls.length === 0) return;
    const first = controls[0]!;
    const last = controls.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const title =
    mode === "item"
      ? "Confirm it’s you"
      : setup
        ? "Protect your Locker"
        : configured === null
          ? "Checking Locker…"
          : "Locker is locked";
  const subtitle =
    mode === "item"
      ? "Re-enter your passphrase to reveal this item"
      : setup
        ? "Create the passphrase required to reveal your secrets"
        : "Enter your passphrase to unlock";

  return (
    <dialog
      open
      ref={dialogRef}
      className={styles.lockscreen}
      aria-modal="true"
      aria-labelledby={`${descriptionId}-title`}
      aria-describedby={descriptionId}
      onKeyDown={trapFocus}
    >
      <span className={styles.lockMark} aria-hidden="true">
        <Icon name="lock" sw={1.7} size={30} stroke="currentColor" />
      </span>
      <div className={styles.heading}>
        <div id={`${descriptionId}-title`} className={styles.lockTitle}>
          {title}
        </div>
        <div id={descriptionId} className={styles.lockSub}>
          {subtitle}
        </div>
      </div>
      {configured !== null || mode === "item" ? (
        <>
          <label className={styles.label} htmlFor={`${descriptionId}-secret`}>
            Passphrase
          </label>
          <input
            id={`${descriptionId}-secret`}
            ref={inputRef}
            className={styles.lockIn}
            type="password"
            autoComplete={setup ? "new-password" : "current-password"}
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !setup && !busy) submit();
            }}
          />
          {setup ? (
            <>
              <label
                className={styles.label}
                htmlFor={`${descriptionId}-confirm`}
              >
                Confirm passphrase
              </label>
              <input
                id={`${descriptionId}-confirm`}
                className={styles.lockIn}
                type="password"
                autoComplete="new-password"
                value={confirm}
                disabled={busy}
                onChange={(event) => setConfirm(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !busy) submit();
                }}
              />
            </>
          ) : null}
          <output className={styles.error} aria-live="polite">
            {localError || error}
          </output>
          <div className={styles.actions}>
            {onCancel ? (
              <button
                type="button"
                className={styles.cancelBtn}
                disabled={busy}
                onClick={onCancel}
              >
                Cancel
              </button>
            ) : null}
            <button
              type="button"
              className={styles.lockBtn}
              disabled={busy}
              onClick={submit}
            >
              {busy
                ? "Checking…"
                : mode === "item"
                  ? "Reveal item"
                  : setup
                    ? "Create passphrase"
                    : "Unlock"}
            </button>
          </div>
        </>
      ) : null}
    </dialog>
  );
}
