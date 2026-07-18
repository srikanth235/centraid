// Ambient module types for the serve-time sibling imports the blueprint apps
// resolve at the root (`./kit.js`, `./react-core.min.js`, `./video-frame.js`)
// or from `../` in components. These files are served verbatim from `kit/` and
// `@centraid/client` — never bundled through tsc — so the wildcard patterns
// below give the apps types without a build-time dependency edge. Signatures
// track the real sources: packages/blueprints/kit/kit.js,
// packages/blueprints/scripts/vendor-react.mjs (the react-core entry points),
// and packages/client/src/video-frame.ts.
//
// This file is a global script (no top-level import/export) so the ambient
// module declarations are global; the `VaultOutcome` / `CentraidChangeDetail`
// they reference come from centraid.d.ts.

// ---------- React runtime bundle ----------
// vendor-react.mjs bundles exactly these entry points into react-core.min.js:
//   export * from 'react';                       (hooks, Fragment, createElement,
//                                                 createContext, StrictMode, …)
//   export { createRoot } from 'react-dom/client';
//   export { flushSync } from 'react-dom';
//   export { jsx, jsxs } from 'react/jsx-runtime';
// Re-export the matching @types so `import { useState } from './react-core.min.js'`
// resolves to React's own types (@types/react + @types/react-dom are hoisted).
//
// @types/react ships as `export = React` (a CommonJS namespace), so a plain
// `export * from 'react'` re-exports NOTHING from this ambient module — every
// `import { useState } from './react-core.min.js'` then fails TS2305. We mirror
// the namespace members explicitly instead: `export import X = React.X` for the
// runtime values (hooks, Fragment, createElement, memo, …) and `export type` for
// the type-only members (FC, ReactNode, event types, …). The DOM-client /
// react-dom / jsx-runtime adds ride their own (ESM) re-exports. This list is a
// superset of what the blueprint apps import today — extend it if a converted
// app reaches for a React API not yet listed.
declare module '*react-core.min.js' {
  import * as React from 'react';
  // ---- Runtime values (hooks + top-level API) ----
  export import useState = React.useState;
  export import useEffect = React.useEffect;
  export import useRef = React.useRef;
  export import useMemo = React.useMemo;
  export import useCallback = React.useCallback;
  export import useContext = React.useContext;
  export import useReducer = React.useReducer;
  export import useLayoutEffect = React.useLayoutEffect;
  export import useId = React.useId;
  export import createContext = React.createContext;
  export import createElement = React.createElement;
  export import cloneElement = React.cloneElement;
  export import Fragment = React.Fragment;
  export import StrictMode = React.StrictMode;
  export import Suspense = React.Suspense;
  export import memo = React.memo;
  export import forwardRef = React.forwardRef;
  export import lazy = React.lazy;
  export import startTransition = React.startTransition;
  export import isValidElement = React.isValidElement;
  export import Children = React.Children;
  // ---- Type-only members ----
  export type FC<P = object> = React.FC<P>;
  export type ReactNode = React.ReactNode;
  export type ReactElement = React.ReactElement;
  export type PropsWithChildren<P = unknown> = React.PropsWithChildren<P>;
  export type CSSProperties = React.CSSProperties;
  export type SVGProps<T> = React.SVGProps<T>;
  export type ChangeEvent<T = Element> = React.ChangeEvent<T>;
  export type KeyboardEvent<T = Element> = React.KeyboardEvent<T>;
  export type MouseEvent<T = Element> = React.MouseEvent<T>;
  export type PointerEvent<T = Element> = React.PointerEvent<T>;
  export type FormEvent<T = Element> = React.FormEvent<T>;
  export type RefObject<T> = React.RefObject<T>;
  export type Ref<T> = React.Ref<T>;
  export type Dispatch<T> = React.Dispatch<T>;
  export type SetStateAction<T> = React.SetStateAction<T>;
  export type ComponentType<P = object> = React.ComponentType<P>;
  export type Key = React.Key;
  // ---- react-dom / jsx-runtime (ESM re-exports) ----
  export { createRoot, hydrateRoot } from 'react-dom/client';
  export { flushSync, createPortal } from 'react-dom';
  export { jsx, jsxs } from 'react/jsx-runtime';
}

// ---------- video-frame (packages/client/src/video-frame.ts) ----------
declare module '*video-frame.js' {
  export const VIDEO_POSTER_EDGE: number;
  export const VIDEO_THUMB_EDGE: number;
  export interface CapturedVideoFrames {
    width: number;
    height: number;
    duration: number | null;
    poster: Blob | null;
    thumb: Blob | null;
  }
  export function captureVideoFrames(source: Blob): Promise<CapturedVideoFrames | null>;
}

// ---------- kit.js (packages/blueprints/kit/kit.js) ----------
declare module '*kit.js' {
  // -- Tiny DOM builders --
  /** Parse an HTML string and return its first element. */
  export function el(html: string): HTMLElement;
  /** Hyperscript builder: `h(tag, {class, html, style, on*}, ...kids)`. */
  export function h(tag: string, props?: Record<string, unknown>, ...kids: unknown[]): HTMLElement;

  // -- Toasts --
  export interface ToastOptions {
    undoLabel?: string;
    onUndo?: () => void;
    duration?: number;
  }
  /** Show a transient toast; returns a dismiss fn. */
  export function toast(text: string, opts?: ToastOptions): () => void;

  /** Translate a typed-command outcome into a human sentence (or null). */
  export function outcomeMessage(outcome: VaultOutcome | null | undefined): string | null;

  // -- Loading / read-error states --
  export function showSkeleton(container: Element, rows?: number): void;
  export function readFailed(bannerEl: HTMLElement | null | undefined): void;

  export interface ReadSubscription {
    managed: boolean;
    unsubscribe: () => void;
  }
  /** Forward a live read's FUTURE values, dropping its duplicated first emission. */
  export function subscribeReadUpdates<T = unknown>(
    read: unknown,
    onUpdate: (value: T) => void,
  ): ReadSubscription;

  // -- Confirm-to-act --
  export function armConfirm(
    btn: HTMLElement,
    opts?: { armedLabel?: string; timeout?: number },
  ): boolean;

  // -- Formatting --
  export function fmtMoney(minor: number | null | undefined, currency?: string): string;
  export function localDayKey(dateish: string | number | Date): string;
  export function localMonthKey(dateish: string | number | Date): string;
  export function relTime(iso: string): string;
  export function debounce<A extends unknown[]>(
    fn: (...args: A) => void,
    ms?: number,
  ): (...args: A) => void;

  // -- Refresh discipline --
  /** Debounced, tables-filtered `window.centraid.onChange`; returns unsubscribe. */
  export function onDataChange(
    tables: string[] | null | undefined,
    cb: (detail: CentraidChangeDetail) => void,
    opts?: { debounceMs?: number },
  ): () => void;
  /** Refresh on window focus (rate-limited); returns unsubscribe. */
  export function onFocusRefresh(cb: () => void, opts?: { minIntervalMs?: number }): () => void;
  /** Call `onNarrow(isNarrow)` when `el` crosses `breakpoint`; returns a stop fn. */
  export function observeWidth(
    el: Element | null,
    breakpoint: number,
    onNarrow: (isNarrow: boolean) => void,
    opts?: { pollMs?: number },
  ): () => void;

  // -- Letter avatars & charts (native elements) --
  export interface AvatarOptions {
    size?: string;
    color?: string;
    initials?: string;
    src?: string;
    shape?: string;
  }
  export function letterAvatar(name: string, opts?: AvatarOptions): HTMLElement;

  export interface ChartPoint {
    x: number;
    y: number;
  }
  export function lineChart(
    points: ChartPoint[],
    opts?: { width?: number; height?: number; label?: string },
  ): HTMLElement;
  export function barSpan(ratio: number, opts?: { tone?: string }): HTMLElement;
  export interface BarItem {
    label: string;
    value: number;
  }
  export function barChart(
    items: BarItem[],
    opts?: { width?: number; height?: number; label?: string },
  ): HTMLElement;

  // -- Attachments --
  export const BLOB_ROUTE: string;
  export const INLINE_ATTACH_BYTES: number;
  export function fileToDataUri(file: File): Promise<string>;
  export function sha256File(file: File): Promise<string | null>;
  /** Staging receipt returned by the blob door. */
  export interface StagedBlob {
    sha256: string;
    mediaType?: string | null;
    byteSize?: number;
    existingContentId?: string | null;
    casAck?: string | null;
    custody?: string | null;
    alreadyPresent?: boolean;
    [k: string]: unknown;
  }
  export function stageDerivative(
    parentSha: string,
    variant: string,
    body: BodyInit,
    mediaType?: string,
  ): Promise<StagedBlob>;
  export function isPendingOffsite(staged: StagedBlob | null | undefined): boolean;
  export function stageFileBytes(
    file: File,
    extra?: string,
    opts?: { hash?: boolean },
  ): Promise<StagedBlob>;
  export function fmtBytes(n: number | null | undefined, empty?: string): string;

  /** One rendered attachment (the shape the strip/remove flow reads). */
  export interface Attachment {
    attachment_id: string;
    content_id?: string;
    media_type?: string;
    title?: string;
    content_uri?: string;
    byte_size?: number;
    [k: string]: unknown;
  }
  export function renderAttachments(
    stripEl: HTMLElement,
    list: Attachment[] | null | undefined,
    onRemove: ((attachmentId: string) => Promise<VaultOutcome | undefined>) | null,
    opts?: { onZoom?: (attachment: Attachment) => void },
  ): void;
  export function wireAttachInput(
    inputEl: HTMLInputElement,
    getSubjectId: () => string | null | undefined,
    handlers: {
      act: (action: string, input: Record<string, unknown>) => Promise<VaultOutcome | undefined>;
      narrate: (outcome: VaultOutcome | undefined) => boolean;
      notice?: (text: string) => void;
      refresh?: () => void | Promise<void>;
    },
  ): void;

  // -- Anchored popover menu --
  export function isPopoverOpen(): boolean;
  export function closePopover(): void;
  export function openPopover(
    anchor: HTMLElement,
    build: (box: HTMLElement) => void,
    opts?: { focus?: boolean; className?: string; role?: string; onClose?: () => void },
  ): void;
  export function popItem(
    label: string,
    onClick: (event: MouseEvent) => void,
    opts?: {
      danger?: boolean;
      disabled?: boolean;
      iconHtml?: string | null;
      dotColor?: string | null;
    },
  ): HTMLButtonElement;

  // -- Empty state & search snippets --
  export function emptyState(
    container: HTMLElement,
    opts?: { icon?: string | Node; title?: string; sub?: string; action?: Node },
  ): void;
  export function snippetInto(target: HTMLElement, snippet: string | null | undefined): void;

  // -- Bulk runner --
  export function runBulk(
    ids: string[],
    run: (id: string) => Promise<VaultOutcome | undefined>,
    opts: {
      progress: string;
      done: string;
      suffix?: string;
      notice: (text: string) => void;
      friendly?: (outcome: VaultOutcome | undefined) => string | null;
      after?: () => void | Promise<void>;
    },
  ): Promise<void>;

  // -- Theme toggle --
  export function isDarkNow(): boolean;
  export function wireThemeToggle(
    btn: HTMLElement,
    opts?: { onChange?: (dark: boolean) => void },
  ): () => void;

  // -- Shared kind-label helper (re-exported from elements.js) --
  export function entityKindLabel(kind: string): string;

  // -- Inline references & @-mentions (core.link + kit popover, issue #272/#282) --
  /** One resolved cross-reference the strip/chip helpers render. */
  export interface Reference {
    linkId?: string;
    type?: string;
    id?: string;
    relation?: string;
    [k: string]: unknown;
  }
  export function createReference(
    from: { type: string; id: string },
    to: { type: string; id: string },
    relation: string,
    selector?: unknown,
  ): Promise<VaultOutcome>;
  export function removeReference(linkId: string): Promise<VaultOutcome>;
  export function renderReferenceStrip(
    stripEl: HTMLElement,
    refs: Reference[] | null | undefined,
    options?: Record<string, unknown>,
  ): void;
  export function reanchorReference(linkId: string, selector: unknown): Promise<VaultOutcome>;
  export function computeMentionSelector(text: string, start: number, end: number): unknown;
  export function assignAnchors(body: string, anchors: unknown): unknown;
  export function attachMentionPopover(
    textarea: HTMLTextAreaElement,
    options?: Record<string, unknown>,
  ): () => void;
  export function mentionChip(ref: Reference): HTMLElement;
  export function resolveInlineSpans(body: string, refs: Reference[]): unknown;
  export function inlineLinkIds(body: string, refs: Reference[]): string[];
  export function appendWithChips(
    el: HTMLElement,
    text: string,
    absStart: number,
    spans: unknown,
    renderPlain: unknown,
  ): void;
  export function attachMentionField(
    textarea: HTMLTextAreaElement,
    options?: Record<string, unknown>,
  ): () => void;
}
