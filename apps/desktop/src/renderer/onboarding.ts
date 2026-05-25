// First-run onboarding view. Mounted by app.ts when
// `settings.onboardingCompletedAt` is absent (a fresh install). Owns
// the root element while it's up; on completion the host re-renders
// home with the freshly-personalized profile in the sidebar.
//
// Why a dedicated view (vs. a modal over home):
//   - Home depends on the active gateway being personalized — the
//     sidebar's head row reads `displayName`, the switcher does too —
//     so showing home before onboarding leaks the auto-created
//     fallback label (e.g. "Local") into the chrome the user has to
//     scan past.
//   - First impressions matter. A welcome view sets a tone the rest
//     of the chrome can't (it's all dense utility surface).
//
// The view is intentionally a single step: a name + a color. We don't
// gate on Local/Remote here — Local is the default and remote can be
// added at any time from the gateway switcher. Adding kind selection
// here would push the user into a decision they don't have the context
// to make on minute one.

(function () {
  function el(tag: string, attrs: ElAttrs = {}, children: ElChild | ElChild[] = []): HTMLElement {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class' && typeof v === 'string') {
        node.className = v;
      } else if (k === 'style' && typeof v === 'object' && v !== null) {
        Object.assign(node.style, v as Partial<CSSStyleDeclaration>);
      } else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'trustedHtml' && typeof v === 'string') {
        node.innerHTML = v;
      } else if (v != null && typeof v !== 'function') {
        node.setAttribute(k, String(v));
      }
    }
    const list = Array.isArray(children) ? children : [children];
    for (const c of list) {
      if (c == null || c === false) continue;
      node.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  /** Mirror of `gateway-store.ts#AVATAR_PALETTE`. The values round-trip
   *  through `updateProfileMetadata`, which validates `#RRGGBB`. */
  const AVATAR_PALETTE = [
    '#5B8DEF',
    '#7C5CFF',
    '#E36AD2',
    '#E5734A',
    '#E0B53D',
    '#4FB077',
    '#3FB5C7',
    '#B07A4A',
  ] as const;

  function initials(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length === 0) return '·';
    const parts = trimmed.split(/\s+/).filter((w) => w.length > 0);
    if (parts.length === 1) {
      const w = parts[0] ?? '';
      return (w.charAt(0) + (w.charAt(1) || '')).toUpperCase();
    }
    return ((parts[0]?.charAt(0) ?? '') + (parts[1]?.charAt(0) ?? '')).toUpperCase();
  }

  function mount(opts: {
    root: HTMLElement;
    onComplete: (input: { displayName: string; avatarColor: string }) => Promise<void> | void;
  }): () => void {
    let displayName = '';
    // Random initial color so two fresh installs on the same machine
    // (e.g. dev resets) don't both start on the same swatch.
    let avatarColor: string =
      AVATAR_PALETTE[Math.floor(Math.random() * AVATAR_PALETTE.length)] ?? AVATAR_PALETTE[0];
    let submitting = false;

    // The view is rebuilt only when the avatar color changes (to flip
    // the `data-selected` flags on swatches and the avatar's bg). The
    // name field is uncontrolled — re-rendering on every keystroke
    // would steal focus.
    let viewRoot: HTMLElement;
    let nameInput: HTMLInputElement;
    let avatarDisc: HTMLElement;
    let initialsEl: HTMLElement;
    let submitBtn: HTMLButtonElement;

    const updateAvatar = (): void => {
      avatarDisc.style.background = avatarColor;
      initialsEl.textContent = initials(displayName);
      // Echo the avatar color into the headline's accent dot so the
      // user sees the color choice reflected outside the avatar tile.
      viewRoot.style.setProperty('--onb-accent', avatarColor);
    };

    const updateCta = (): void => {
      const ok = displayName.trim().length > 0 && !submitting;
      submitBtn.disabled = !ok;
      submitBtn.dataset.state = submitting ? 'submitting' : ok ? 'ready' : 'idle';
    };

    const updateSwatches = (): void => {
      viewRoot.querySelectorAll<HTMLElement>('.cd-onb-swatch').forEach((sw) => {
        sw.dataset.selected = sw.dataset.color === avatarColor ? 'true' : 'false';
      });
    };

    const submit = async (): Promise<void> => {
      const name = displayName.trim();
      if (!name || submitting) return;
      submitting = true;
      updateCta();
      try {
        await opts.onComplete({ displayName: name, avatarColor });
        // Host will replace the root with home — nothing else to do.
      } catch (err) {
        submitting = false;
        updateCta();
        // Surface failures inside the view rather than tossing a
        // global toast — the user is still on the welcome surface, so
        // the message has to live here.
        const existing = viewRoot.querySelector('.cd-onb-error');
        if (existing) existing.remove();
        viewRoot
          .querySelector('.cd-onb-form')
          ?.append(
            el(
              'div',
              { class: 'cd-onb-error', role: 'alert' },
              `Couldn't save your profile: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }
    };

    // Build the swatch row. Each swatch carries its hex in a data
    // attribute so re-render can update `data-selected` without
    // touching the DOM tree itself.
    const swatchRow = el('div', { class: 'cd-onb-swatches', role: 'radiogroup' });
    for (const c of AVATAR_PALETTE) {
      const sw = el('button', {
        class: 'cd-onb-swatch',
        type: 'button',
        role: 'radio',
        'aria-label': `Color ${c}`,
        'data-color': c,
        'data-selected': c === avatarColor ? 'true' : 'false',
        style: { background: c },
        onClick: (e: Event) => {
          e.preventDefault();
          avatarColor = c;
          updateAvatar();
          updateSwatches();
        },
      });
      swatchRow.append(sw);
    }

    // Build the avatar preview. The disc gets its color via style and
    // the initials via text node — both updated in place by
    // `updateAvatar` so the preview animates smoothly.
    initialsEl = el('span', { class: 'cd-onb-initials' }, initials(displayName));
    avatarDisc = el(
      'span',
      {
        class: 'cd-onb-avatar',
        style: { background: avatarColor },
        'aria-hidden': 'true',
      },
      initialsEl,
    );
    const avatarRing = el('span', { class: 'cd-onb-avatar-ring', 'aria-hidden': 'true' });
    const avatarWrap = el('div', { class: 'cd-onb-avatar-wrap' }, [avatarRing, avatarDisc]);

    // Name field. Uncontrolled — we read on input + keydown so React-
    // style re-render on every keystroke isn't needed.
    nameInput = el('input', {
      class: 'cd-onb-input',
      type: 'text',
      placeholder: 'What should we call you?',
      autocapitalize: 'words',
      autocomplete: 'name',
      spellcheck: 'false',
      'aria-label': 'Your name',
      maxlength: '60',
    }) as HTMLInputElement;
    nameInput.addEventListener('input', () => {
      displayName = nameInput.value;
      updateAvatar();
      updateCta();
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void submit();
      }
    });

    submitBtn = el('button', {
      class: 'cd-onb-cta',
      type: 'button',
      onClick: () => void submit(),
    }) as HTMLButtonElement;
    submitBtn.append(
      el('span', { class: 'cd-onb-cta-label' }, 'Enter Centraid'),
      el('span', {
        class: 'cd-onb-cta-arrow',
        trustedHtml:
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
      }),
    );

    const form = el('form', {
      class: 'cd-onb-form',
      onSubmit: (e: Event) => {
        e.preventDefault();
        void submit();
      },
    });
    form.append(
      el('label', { class: 'cd-onb-field-label' }, 'Your name'),
      nameInput,
      el('label', { class: 'cd-onb-field-label' }, 'Pick a color'),
      swatchRow,
      submitBtn,
    );

    const card = el('div', { class: 'cd-onb-card' }, [
      el('div', { class: 'cd-onb-eyebrow' }, [
        el('span', { class: 'cd-onb-eyebrow-dot', 'aria-hidden': 'true' }),
        'CENTRAID',
      ]),
      el('h1', { class: 'cd-onb-title' }, ['Make yourself ', el('em', {}, 'at home'), '.']),
      el(
        'p',
        { class: 'cd-onb-sub' },
        'A name and a color. We use them for your local workspace — you can change either at any time.',
      ),
      avatarWrap,
      form,
    ]);

    viewRoot = el('div', { class: 'cd-onb-view', 'data-mounted': 'true' }, [
      // Two atmospheric layers behind the card: a deep gradient base
      // and a soft accent-tinted glow that picks up the user's chosen
      // color. The glow position is fixed; the color updates with
      // every swatch click via `--onb-accent` so the whole stage
      // breathes with the user's choice.
      el('div', { class: 'cd-onb-stage-bg', 'aria-hidden': 'true' }),
      el('div', { class: 'cd-onb-stage-glow', 'aria-hidden': 'true' }),
      card,
    ]);

    // Initial sync — avatar color flows into the headline accent dot
    // and the CTA's disabled state reflects the empty name field.
    opts.root.replaceChildren(viewRoot);
    updateAvatar();
    updateCta();

    // Focus the name input on mount so the user types immediately.
    // `requestAnimationFrame` waits one frame so the CSS entry
    // animation isn't fighting the focus shift.
    requestAnimationFrame(() => nameInput.focus());

    return () => {
      // Cleanup — host (app.ts) calls this when it replaces our root
      // content with home. We don't need to remove listeners explicitly
      // since the elements themselves are about to be GC'd.
      viewRoot.dataset.mounted = 'false';
    };
  }

  window.Onboarding = { mount };
})();
