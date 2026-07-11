import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProfileSwitcherHead from './ProfileSwitcherHead.js';

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(el: React.ReactElement): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const active = { id: 'v1', name: "Owner's vault", color: '#4E68DD', icon: 'Sparkle' } as const;

describe('ProfileSwitcherHead', () => {
  it('renders the active vault name + subtitle', () => {
    const el = render(
      <ProfileSwitcherHead active={active} subtitle="2 apps" onToggle={() => {}} />,
    );
    expect(el.textContent).toContain("Owner's vault");
    expect(el.textContent).toContain('2 apps');
  });

  it('fires onToggle with the button rect when clicked', () => {
    const onToggle = vi.fn();
    const el = render(
      <ProfileSwitcherHead active={active} subtitle="2 apps" onToggle={onToggle} />,
    );
    act(() => (el.querySelector('button') as HTMLButtonElement).click());
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ left: expect.any(Number) }));
  });

  it('reflects the open state via data-open', () => {
    const el = render(
      <ProfileSwitcherHead active={active} subtitle="2 apps" open onToggle={() => {}} />,
    );
    expect((el.querySelector('button') as HTMLButtonElement | null)?.dataset.open).toBe('true');
  });

  it('shows a quiet placeholder and disables the button while the vault is unresolved', () => {
    const onToggle = vi.fn();
    const el = render(<ProfileSwitcherHead subtitle="—" onToggle={onToggle} />);
    const btn = el.querySelector('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(el.textContent).toContain('Loading…');
    // Disabled buttons don't dispatch click handlers in jsdom either — assert
    // no crash rendering the placeholder is the real contract here.
    expect(() => act(() => btn.click())).not.toThrow();
  });
});
