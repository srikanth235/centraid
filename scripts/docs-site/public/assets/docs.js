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

  // ---------- header search (⌘K) ----------
  const searchBtn = document.querySelector('#doc-search');
  if (searchBtn) {
    const indexUrl = searchBtn.dataset.index;
    let records = null;
    let loading = null;
    let selected = 0;
    let hits = [];

    const overlay = document.createElement('div');
    overlay.className = 'search-overlay';
    overlay.innerHTML = `
      <div class="search-panel" role="dialog" aria-modal="true" aria-label="Search the docs">
        <div class="search-input-row">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>
          <input type="search" placeholder="Search the docs…" aria-label="Search the docs" autocomplete="off" spellcheck="false" />
          <span class="search-esc">esc</span>
        </div>
        <div class="search-results" role="listbox"></div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('input');
    const results = overlay.querySelector('.search-results');

    const esc = (s) =>
      s.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      );
    const terms = () => input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const highlight = (text, ts) => {
      let out = esc(text);
      for (const t of ts) {
        const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        out = out.replace(re, '<mark>$1</mark>');
      }
      return out;
    };

    const render = () => {
      const ts = terms();
      if (!ts.length) {
        hits = [];
        results.innerHTML = '';
        return;
      }
      hits = (records || [])
        .map((r) => {
          const fields = {
            title: (r.title || '').toLowerCase(),
            kicker: (r.kicker || '').toLowerCase(),
            page: (r.page || '').toLowerCase(),
            text: (r.text || '').toLowerCase(),
          };
          let score = 0;
          for (const t of ts) {
            const s =
              (fields.title.includes(t) ? 6 : 0) +
              (fields.kicker.includes(t) ? 3 : 0) +
              (fields.page.includes(t) ? 2 : 0) +
              (fields.text.includes(t) ? 1 : 0);
            if (s === 0) return null;
            score += s;
          }
          return { r, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12)
        .map((x) => x.r);
      selected = 0;
      if (!hits.length) {
        results.innerHTML = `<p class="search-empty">No matches for “${esc(input.value)}”.</p>`;
        return;
      }
      results.innerHTML = hits
        .map(
          (r, i) => `
        <a class="search-hit" href="${esc(r.href)}" role="option" aria-selected="${i === 0}">
          <span class="hit-top"><span class="hit-title">${highlight(r.title || '', ts)}</span><span class="hit-page">${esc(r.page || '')}</span></span>
          ${r.text ? `<span class="hit-text">${highlight(r.text, ts)}</span>` : ''}
        </a>`,
        )
        .join('');
    };

    const paintSelection = () => {
      const nodes = results.querySelectorAll('.search-hit');
      nodes.forEach((n, i) => {
        const on = i === selected;
        n.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) n.scrollIntoView({ block: 'nearest' });
      });
    };

    const open = async () => {
      document.querySelector('#mobile-menu')?.classList.remove('open');
      overlay.classList.add('open');
      input.value = '';
      results.innerHTML = '';
      input.focus();
      if (!records && !loading) {
        loading = fetch(indexUrl)
          .then((r) => (r.ok ? r.json() : []))
          .then((data) => {
            records = data;
          })
          .catch(() => {
            records = [];
          });
      }
      await loading;
    };
    const close = () => {
      overlay.classList.remove('open');
      searchBtn.focus();
    };

    searchBtn.addEventListener('click', open);
    input.addEventListener('input', render);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (overlay.classList.contains('open')) close();
        else open();
        return;
      }
      if (!overlay.classList.contains('open')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown' && hits.length) {
        e.preventDefault();
        selected = (selected + 1) % hits.length;
        paintSelection();
      } else if (e.key === 'ArrowUp' && hits.length) {
        e.preventDefault();
        selected = (selected - 1 + hits.length) % hits.length;
        paintSelection();
      } else if (e.key === 'Enter' && hits[selected]) {
        e.preventDefault();
        window.location.href = hits[selected].href;
      }
    });
  }

  // ---------- mobile menu ----------
  const navToggle = document.querySelector('#nav-toggle');
  const mobileMenu = document.querySelector('#mobile-menu');
  if (navToggle && mobileMenu) {
    const mmRail = document.querySelector('#mm-rail');
    const mmSections = document.querySelector('#mm-sections');
    const rail = document.querySelector('.rail');
    // Mirror the current page's section rail (hidden on mobile) into the menu,
    // re-cloned on each open so the active-section highlight stays in sync.
    const syncSections = () => {
      if (!rail || !mmRail) return;
      mmRail.replaceChildren();
      for (const a of rail.querySelectorAll('a')) mmRail.appendChild(a.cloneNode(true));
      if (mmSections) mmSections.hidden = mmRail.childElementCount === 0;
    };
    const setOpen = (open) => {
      mobileMenu.classList.toggle('open', open);
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      if (open) syncSections();
    };
    navToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(!mobileMenu.classList.contains('open'));
    });
    mobileMenu.addEventListener('click', (e) => {
      if (e.target.closest('a')) setOpen(false);
    });
    document.addEventListener('click', (e) => {
      if (
        mobileMenu.classList.contains('open') &&
        !mobileMenu.contains(e.target) &&
        !navToggle.contains(e.target)
      ) {
        setOpen(false);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && mobileMenu.classList.contains('open')) setOpen(false);
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 1000 && mobileMenu.classList.contains('open')) setOpen(false);
    });
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
