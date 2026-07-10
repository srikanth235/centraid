/* oxlint-disable typescript-eslint/ban-ts-comment -- the package tsconfig has
   no DOM lib (the blueprints "src" is node-side); this one file runs the
   browser kit + vendored React under jsdom, so DOM globals are runtime-real
   but invisible to tsc. Suppressing per-file beats adding DOM types to the
   whole package. */
// @ts-nocheck — imports the untyped vendored bundles (plain JS + DOM globals)
// @vitest-environment jsdom
// Runtime smoke test: evaluates the real `kit/react-core.min.js` +
// `kit/jsx-runtime.js` bundles under jsdom and exercises the surface
// builder-generated React apps consume, plus the React/kit-custom-element
// interop the runtime depends on.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolved at runtime so tsc never follows the import into the vendored
// react-core bundle (which its DOM-less config can't type-check). The file
// URL loads natively; jsdom's globals are already installed by the environment.
const reactCoreUrl = pathToFileURL(path.resolve(process.cwd(), 'kit/react-core.min.js')).href;
const jsxRuntimeUrl = pathToFileURL(path.resolve(process.cwd(), 'kit/jsx-runtime.js')).href;
const kitUrl = pathToFileURL(path.resolve(process.cwd(), 'kit/kit.js')).href;

const bundle = await import(reactCoreUrl);
const {
  createRoot,
  flushSync,
  jsx,
  jsxs,
  Fragment,
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  createElement,
} = bundle;

describe('react-core bundle surface', () => {
  it('exports the hooks + render entry points as functions', () => {
    for (const [name, fn] of Object.entries({
      createRoot,
      flushSync,
      jsx,
      jsxs,
      useState,
      useEffect,
      useRef,
      useMemo,
      useCallback,
      createElement,
    })) {
      expect(fn, name).toBeTypeOf('function');
    }
  });

  it('exports Fragment (a symbol-like token, not a function)', () => {
    expect(Fragment).toBeDefined();
    expect(bundle).toHaveProperty('Fragment');
  });
});

describe('createRoot renders and reacts to state updates', () => {
  it('mounts a component and re-renders it after a click drives useState', async () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return createElement('button', { onClick: () => setCount((c) => c + 1) }, `clicks: ${count}`);
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(Counter));
    });

    const button = container.querySelector('button');
    expect(button).toBeTruthy();
    expect(button.textContent).toBe('clicks: 0');

    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    // React's event-driven state updates from a real DOM event are batched
    // into a microtask-scheduled commit; give it a tick.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(button.textContent).toBe('clicks: 1');

    root.unmount();
  });
});

describe('React + kit custom elements coexist in one tree', () => {
  it('renders <kit-avatar> via React.createElement and gets initials from the name property', async () => {
    await import(kitUrl); // registers kit-avatar (and the rest of the kit elements)

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement('kit-avatar', { name: 'Ada Lovelace' }));
    });

    const host = container.querySelector('kit-avatar');
    expect(host).toBeTruthy();
    await host.updateComplete;

    // React 19 sets `name` as a JS *property* on the custom element instance
    // (host.name === 'Ada Lovelace'), not merely as an HTML attribute —
    // custom-element props whose key already exists on the element instance
    // (kit-avatar's Lit `static properties` accessor defines `name` on the
    // prototype) are assigned via property set, same as DOM-known props like
    // `value` on <input>. Lit's own attribute reflection is a secondary path
    // here: it doesn't matter which carried the value in this case because
    // the property accessor is what actually re-renders the element, and
    // React went through the property setter directly.
    expect(host.name).toBe('Ada Lovelace');

    const span = host.querySelector('.kit-avatar');
    expect(span).toBeTruthy();
    expect(span.textContent.trim()).toBe('AL');

    root.unmount();
  });
});

describe('jsx-runtime.js re-exports the same React instance', () => {
  it('jsx/jsxs/Fragment are referentially identical to the react-core bundle', async () => {
    const runtime = await import(jsxRuntimeUrl);
    expect(runtime.jsx).toBe(bundle.jsx);
    expect(runtime.jsxs).toBe(bundle.jsxs);
    expect(runtime.Fragment).toBe(bundle.Fragment);
  });
});

describe('production build guard', () => {
  it('does not contain React dev-mode markers', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'kit/react-core.min.js'), 'utf8');
    // `react` / `react-dom` have no "production" package.json export
    // condition (unlike lit) — both CJS entry files branch on
    // `process.env.NODE_ENV` at require-time between e.g.
    // `require('./cjs/react.development.js')` and
    // `require('./cjs/react-dom.development.js')`. Bundling with
    // `NODE_ENV=production` inlines that check and dead-code-eliminates the
    // `.development.js` branch entirely, so its require-path *string*
    // disappears from the output — verified empirically: building this same
    // entry file with NODE_ENV=development leaves both substrings present
    // verbatim, and the dev bundle is also ~5x larger (~1MB vs ~193KB) from
    // the unstripped warning/invariant machinery.
    expect(src).not.toContain('react.development');
    expect(src).not.toContain('react-dom.development');
  });
});
