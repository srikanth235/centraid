/* Centraid docs — shared shell behavior.
   Theme (shared storage key with centraid.dev), scroll reveals,
   rail scrollspy, copy buttons. No dependencies. */
(() => {
  const root = document.documentElement;

  // ---------- theme ----------
  const saved = localStorage.getItem('centraid-theme');
  if (saved) {
    root.dataset.theme = saved;
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    root.dataset.theme = 'night';
  }
  const icons = {
    paper:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    night:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>',
  };
  const toggle = document.querySelector('#theme-toggle');
  const syncIcon = () => {
    if (toggle) toggle.innerHTML = icons[root.dataset.theme === 'night' ? 'night' : 'paper'];
  };
  syncIcon();
  toggle?.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'night' ? 'paper' : 'night';
    localStorage.setItem('centraid-theme', root.dataset.theme);
    syncIcon();
  });

  // ---------- scroll reveals ----------
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    document.querySelectorAll('.r').forEach((el) => el.classList.add('in'));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.1, rootMargin: '0px 0px -40px 0px' },
    );
    document.querySelectorAll('.r').forEach((el) => io.observe(el));
  }

  // ---------- rail scrollspy ----------
  const links = [...document.querySelectorAll('.rail a')];
  const secs = links.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  if (secs.length) {
    const setOn = (id) => {
      links.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + id));
    };
    const spy = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setOn(e.target.id);
        }
      },
      { rootMargin: '-25% 0px -65% 0px' },
    );
    secs.forEach((s) => spy.observe(s));
  }

  // ---------- copy buttons ----------
  document.querySelectorAll('.copy-btn').forEach((btn) => {
    const original = btn.innerHTML;
    btn.addEventListener('click', async () => {
      const text =
        btn.dataset.copy || btn.closest('.term')?.querySelector('code')?.textContent || '';
      try {
        await navigator.clipboard.writeText(text.trim());
      } catch {
        /* clipboard unavailable (insecure context / denied) — ignore */
      }
      btn.classList.add('done');
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 13l4 4L19 7"/></svg>';
      setTimeout(() => {
        btn.classList.remove('done');
        btn.innerHTML = original;
      }, 1600);
    });
  });
})();
