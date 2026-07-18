// Tiny id lookup shared by app.tsx and the plain-TS helper modules that still
// touch the static (non-React-owned) DOM directly — a one-line module purely
// to avoid duplicating this across app.tsx and upload.ts/outcomes.ts. Generic
// on the element type (default HTMLElement): every id here exists in the
// static index.html body, so the lookup is asserted non-null, and the few call
// sites that need a `.value`/`.files`/`.disabled` member pass the concrete
// element type (`$<HTMLInputElement>('searchInput')`).
export const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;
