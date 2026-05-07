(function () {
  const STORAGE = 'focus.stats';
  type ModeKey = 'work' | 'shortBreak' | 'longBreak';
  interface ModeDef {
    label: string;
    seconds: number;
  }
  interface FocusStats {
    todayKey: string;
    completed: number;
    totalCompleted: number;
  }

  const MODES: Record<ModeKey, ModeDef> = {
    longBreak: { label: 'Long break', seconds: 15 * 60 },
    shortBreak: { label: 'Short break', seconds: 5 * 60 },
    work: { label: 'Focus', seconds: 25 * 60 },
  };

  function mount(root: HTMLElement): () => void {
    let mode: ModeKey = 'work';
    let remaining = MODES[mode].seconds;
    let running = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    let stats = Store.get<FocusStats>(STORAGE, {
      completed: 0,
      todayKey: DateUtil.todayKey(),
      totalCompleted: 0,
    });
    if (stats.todayKey !== DateUtil.todayKey()) {
      stats = {
        completed: 0,
        todayKey: DateUtil.todayKey(),
        totalCompleted: stats.totalCompleted || 0,
      };
      Store.set(STORAGE, stats);
    }

    const { el } = window.Centraid;

    function fmt(secs: number): string {
      const m = Math.floor(secs / 60)
        .toString()
        .padStart(2, '0');
      const s = (secs % 60).toString().padStart(2, '0');
      return `${m}:${s}`;
    }

    function setMode(next: ModeKey): void {
      mode = next;
      remaining = MODES[mode].seconds;
      running = false;
      if (interval) {
        clearInterval(interval);
      }
      render();
    }

    function tick(): void {
      if (remaining > 0) {
        remaining -= 1;
        updateTime();
        return;
      }
      if (interval) {
        clearInterval(interval);
      }
      interval = null;
      running = false;
      if (mode === 'work') {
        stats.completed += 1;
        stats.totalCompleted += 1;
        Store.set(STORAGE, stats);
        mode = 'shortBreak';
        remaining = MODES[mode].seconds;
      } else {
        mode = 'work';
        remaining = MODES[mode].seconds;
      }
      render();
    }

    function startStop(): void {
      if (running) {
        running = false;
        if (interval) {
          clearInterval(interval);
        }
        interval = null;
      } else {
        running = true;
        interval = setInterval(tick, 1000);
      }
      render();
    }

    function reset(): void {
      running = false;
      if (interval) {
        clearInterval(interval);
      }
      interval = null;
      remaining = MODES[mode].seconds;
      render();
    }

    function skip(): void {
      remaining = 0;
      tick();
    }

    function updateTime(): void {
      const tnode = root.querySelector('.focus-time');
      if (tnode) {
        tnode.textContent = fmt(remaining);
      }
      const ring = root.querySelector('.focus-progress-ring circle.bar') as SVGCircleElement | null;
      if (ring) {
        const circ = 2 * Math.PI * Number(ring.getAttribute('r'));
        const pct = 1 - remaining / MODES[mode].seconds;
        ring.style.strokeDasharray = `${circ}`;
        ring.style.strokeDashoffset = `${circ * (1 - pct)}`;
      }
    }

    function render(): void {
      root.innerHTML = '';
      const header = el('div', { class: 'app-header' }, [
        el('div', {}, [
          el('h1', { class: 'app-title' }, 'Focus'),
          el(
            'p',
            { class: 'app-subtitle' },
            MODES[mode].label + ' · 25-minute work blocks with breaks.',
          ),
        ]),
      ]);
      root.append(header);

      const tabs = el(
        'div',
        { class: 'focus-mode-tabs' },
        (
          [
            ['work', 'Focus'],
            ['shortBreak', 'Short break'],
            ['longBreak', 'Long break'],
          ] as const
        ).map(([key, label]) =>
          el(
            'button',
            {
              'data-active': String(mode === key),
              onClick: () => setMode(key),
            },
            label,
          ),
        ),
      );

      const radius = 130;
      const circ = 2 * Math.PI * radius;
      const pct = 1 - remaining / MODES[mode].seconds;
      const ring = `<svg class="focus-progress-ring" viewBox="0 0 280 280">
        <circle cx="140" cy="140" r="${radius}" stroke="rgba(0,0,0,.06)" />
        <circle class="bar" cx="140" cy="140" r="${radius}"
                stroke="${getComputedStyle(root).getPropertyValue('--accent-color').trim() || '#5847e0'}"
                stroke-dasharray="${circ}"
                stroke-dashoffset="${circ * (1 - pct)}"
                stroke-linecap="round" />
      </svg>`;

      const dial = el('div', { class: 'focus-dial' }, [
        el('div', { trustedHtml: ring }),
        el('div', { class: 'focus-time' }, fmt(remaining)),
      ]);

      const actions = el('div', { class: 'focus-actions' }, [
        el('button', {
          class: 'btn btn-primary',
          trustedHtml:
            (running ? Icon.Pause({ size: 14 }) : Icon.Play({ size: 14 })) +
            `<span>${running ? 'Pause' : 'Start'}</span>`,
          onClick: startStop,
        }),
        el('button', {
          class: 'btn btn-soft',
          trustedHtml: Icon.Reset({ size: 14 }) + '<span>Reset</span>',
          onClick: reset,
        }),
        el('button', {
          class: 'btn btn-soft',
          trustedHtml: Icon.Skip({ size: 14 }) + '<span>Skip</span>',
          onClick: skip,
        }),
      ]);

      const stage = el('div', { class: 'focus-stage' }, [tabs, dial, actions]);
      root.append(stage);

      root.append(
        el('div', { class: 'focus-stats mt-4' }, [
          el('div', {}, [el('b', {}, String(stats.completed)), 'today']),
          el('div', {}, [el('b', {}, String(stats.totalCompleted)), 'total']),
        ]),
      );
    }

    render();
    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }

  window.CentraidApps = window.CentraidApps || {};
  window.CentraidApps.focus = { mount };
})();
