// @ts-nocheck — imports the untyped browser kit (plain JS + DOM globals)
// @vitest-environment jsdom
// Runtime smoke test: evaluates the real kit modules (elements.js + kit.js)
// under jsdom and exercises the shared surface the apps consume.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolved at runtime so tsc never follows the import into the vendored
// lit-core bundle (which its DOM-less config can't type-check). The file URL
// loads natively; jsdom's globals are already installed by the environment.
const kitUrl = pathToFileURL(path.resolve(process.cwd(), 'kit/kit.js')).href;
const {
  barSpan,
  el,
  emptyState,
  fmtBytes,
  h,
  isPopoverOpen,
  letterAvatar,
  openPopover,
  closePopover,
  popItem,
  renderAttachments,
  snippetInto,
} = await import(kitUrl);

describe('kit smoke', () => {
  it('defines the custom elements', () => {
    for (const tag of [
      'kit-avatar',
      'kit-meter',
      'kit-line-chart',
      'kit-bar-chart',
      'kit-skeleton',
      'kit-toast',
      'kit-mention-chip',
      'kit-reference-strip',
    ]) {
      expect(customElements.get(tag), tag).toBeTruthy();
    }
  });

  it('h/el build DOM', () => {
    const n = h('div', { class: 'x', onclick: () => {} }, 'hi', null, false, ['a']);
    expect(n.className).toBe('x');
    expect(n.textContent).toBe('hia');
    expect(el('<span id="q">z</span>').id).toBe('q');
  });

  it('letterAvatar honours color/initials and scales type', async () => {
    const av = letterAvatar('Grace Hopper', { size: '34px', color: '#0FA678', initials: 'You' });
    document.body.appendChild(av);
    await av.updateComplete;
    const span = av.querySelector('.kit-avatar');
    expect(span).toBeTruthy();
    expect(span.getAttribute('style')).toContain('background:#0FA678');
    expect(span.getAttribute('style')).toContain('font-size:calc(34px * 0.36)');
    expect(span.textContent.trim()).toBe('You');
  });

  it('letterAvatar defaults to hashed hue + derived initials', async () => {
    const av = letterAvatar('Ada Lovelace');
    document.body.appendChild(av);
    await av.updateComplete;
    const span = av.querySelector('.kit-avatar');
    expect(span.getAttribute('style')).toMatch(/background:hsl\(/);
    expect(span.textContent.trim()).toBe('AL');
  });

  it('barSpan carries the tone onto the fill', async () => {
    const bar = barSpan(0.8, { tone: 'ok' });
    document.body.appendChild(bar);
    await bar.updateComplete;
    expect(bar.querySelector('.kit-bar-fill').dataset.tone).toBe('ok');
  });

  it('renderAttachments renders tiles; onRemove:null omits the control', () => {
    const strip = document.createElement('div');
    const list = [
      { attachment_id: 'a1', media_type: 'image/png', content_uri: 'x.png', byte_size: 2048 },
      { attachment_id: 'a2', media_type: 'application/pdf', content_uri: 'x.pdf', title: 'Doc' },
    ];
    renderAttachments(strip, list, null);
    expect(strip.querySelectorAll('.kit-attach-tile').length).toBe(2);
    expect(strip.querySelector('.kit-attach-remove')).toBeNull();
    renderAttachments(strip, list, () => {}, { onZoom: () => {} });
    expect(strip.querySelectorAll('.kit-attach-remove').length).toBe(2);
    expect(strip.querySelector('img.kit-attach-zoom')).toBeTruthy();
    expect(strip.querySelector('.kit-attach-meta').textContent).toBe('2 KB');
  });

  it('popover opens, reports, closes', () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    expect(isPopoverOpen()).toBe(false);
    openPopover(anchor, (box) => box.appendChild(popItem('Move', () => {}, { dotColor: 'red' })));
    expect(isPopoverOpen()).toBe(true);
    const box = document.querySelector('.kit-popover');
    expect(box).toBeTruthy();
    expect(box.querySelector('.kit-popover-item')).toBeTruthy();
    expect(box.querySelector('.kit-dotmini')).toBeTruthy();
    closePopover();
    expect(isPopoverOpen()).toBe(false);
    expect(document.querySelector('.kit-popover')).toBeNull();
  });

  it('emptyState fills + unhides the container', () => {
    const box = document.createElement('div');
    box.hidden = true;
    emptyState(box, { icon: '<svg></svg>', title: 'Nothing here', sub: 'Add one.' });
    expect(box.hidden).toBe(false);
    expect(box.querySelector('.kit-empty-title').textContent).toBe('Nothing here');
    expect(box.querySelector('.kit-empty-icon')).toBeTruthy();
  });

  it('snippetInto marks the hits', () => {
    const t = document.createElement('p');
    snippetInto(t, 'find ⟦this⟧ word');
    expect(t.querySelector('mark').textContent).toBe('this');
    expect(t.textContent).toBe('find this word');
  });

  it('fmtBytes labels', () => {
    expect(fmtBytes(0)).toBe('');
    expect(fmtBytes(0, '—')).toBe('—');
    expect(fmtBytes(500)).toBe('500 B');
    expect(fmtBytes(1024 * 1024 * 1.3)).toBe('1.3 MB');
  });
});
