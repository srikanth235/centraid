/* Centraid landing page interactivity — zero dependencies.
 *
 * 1. Theme toggle synced with `centraid-theme` (shared with /docs/).
 * 2. Hero phone view switcher (tabs + floating courtyard cards).
 * 3. Interactive app playground with keyboard arrow navigation.
 * 4. Playable on-device assistant prompts with live Add / Undo.
 * 5. Blind-backup perspective flipper (your phone vs your backup machine).
 */
(() => {
  const root = document.documentElement;
  const mediaDark = window.matchMedia("(prefers-color-scheme: dark)");

  const resolvedTheme = () =>
    root.dataset.theme === "light" || root.dataset.theme === "dark"
      ? root.dataset.theme
      : mediaDark.matches
        ? "dark"
        : "light";

  // --- Theme toggle ---------------------------------------------------------
  const themeBtn = document.querySelector("#theme-toggle");
  const syncThemeLabel = () => {
    if (!themeBtn) return;
    const next = resolvedTheme() === "dark" ? "light" : "dark";
    themeBtn.setAttribute("aria-label", `Switch to ${next} theme`);
  };
  syncThemeLabel();

  themeBtn?.addEventListener("click", () => {
    const next = resolvedTheme() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem("centraid-theme", next);
    } catch {
      /* storage blocked — theme still applies for this view */
    }
    syncThemeLabel();
  });
  mediaDark.addEventListener("change", syncThemeLabel);

  // --- Keyboard arrow support for tablists ----------------------------------
  const bindTabKeys = (tabs, activate) => {
    tabs.forEach((tab, index) => {
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        event.preventDefault();
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const nextIndex = (index + delta + tabs.length) % tabs.length;
        const nextTab = tabs[nextIndex];
        activate(nextTab);
        nextTab.focus();
      });
    });
  };

  // --- Hero phone switcher --------------------------------------------------
  const heroTabs = [...document.querySelectorAll(".stage-tab[data-hero-tab]")];
  const heroFloats = [
    ...document.querySelectorAll(".float-card[data-hero-tab]"),
  ];
  const heroPanels = [
    ...document.querySelectorAll(".ph-body[data-hero-panel]"),
  ];

  const selectHero = (key) => {
    for (const panel of heroPanels) {
      panel.hidden = panel.dataset.heroPanel !== key;
    }
    for (const tab of heroTabs) {
      const on = tab.dataset.heroTab === key;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    for (const card of heroFloats) {
      card.classList.toggle("is-lit", card.dataset.heroTab === key);
    }
  };

  for (const el of [...heroTabs, ...heroFloats]) {
    el.addEventListener("click", () => selectHero(el.dataset.heroTab));
  }
  bindTabKeys(heroTabs, (tab) => selectHero(tab.dataset.heroTab));

  // --- App playground -------------------------------------------------------
  const appTabs = [...document.querySelectorAll(".dock-pill[data-app]")];
  const appPanels = [
    ...document.querySelectorAll(".app-stage-panel[data-app-panel]"),
  ];

  const selectApp = (key) => {
    for (const panel of appPanels) {
      panel.hidden = panel.dataset.appPanel !== key;
    }
    for (const tab of appTabs) {
      const on = tab.dataset.app === key;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    }
  };

  for (const tab of appTabs) {
    tab.addEventListener("click", () => selectApp(tab.dataset.app));
  }
  bindTabKeys(appTabs, (tab) => selectApp(tab.dataset.app));

  // --- Playable on-device assistant -----------------------------------------
  const promptBtns = [...document.querySelectorAll(".prompt-btn[data-prompt]")];
  const chatPanels = [
    ...document.querySelectorAll(".lc-panel[data-chat-panel]"),
  ];

  const selectPrompt = (key) => {
    for (const btn of promptBtns) {
      btn.setAttribute("aria-pressed", String(btn.dataset.prompt === key));
    }
    for (const panel of chatPanels) {
      panel.hidden = panel.dataset.chatPanel !== key;
    }
  };

  for (const btn of promptBtns) {
    btn.addEventListener("click", () => selectPrompt(btn.dataset.prompt));
  }

  const addRemBtn = document.querySelector("#demo-add-rem");
  const skipRemBtn = document.querySelector("#demo-skip-rem");
  const undoRemBtn = document.querySelector("#demo-undo-rem");
  const remTitle = document.querySelector("#demo-rem-title");
  const remStatus = document.querySelector("#demo-rem-status");

  const setReminderState = (state) => {
    if (!addRemBtn || !skipRemBtn || !undoRemBtn || !remTitle || !remStatus)
      return;
    if (state === "added") {
      remTitle.textContent = "✓ Call Mum";
      remStatus.textContent =
        "Saved to Reminders · Sunday, 10:00 · Linked to Mum";
      addRemBtn.hidden = true;
      skipRemBtn.hidden = true;
      undoRemBtn.hidden = false;
      undoRemBtn.textContent = "Added to Reminders · Undo";
    } else if (state === "skipped") {
      remTitle.textContent = "○ Call Mum";
      remStatus.textContent = "Not added · Nothing changed in your vault";
      addRemBtn.hidden = false;
      skipRemBtn.hidden = true;
      undoRemBtn.hidden = true;
    } else {
      remTitle.textContent = "○ Call Mum";
      remStatus.textContent = "Reminders · Sunday, 10:00 · Linked to Mum";
      addRemBtn.hidden = false;
      skipRemBtn.hidden = false;
      undoRemBtn.hidden = true;
    }
  };

  addRemBtn?.addEventListener("click", () => setReminderState("added"));
  skipRemBtn?.addEventListener("click", () => setReminderState("skipped"));
  undoRemBtn?.addEventListener("click", () => setReminderState("pending"));

  // --- Interactive blind-backup flipper -------------------------------------
  const backupBox = document.querySelector("#backup-interactive");
  const viewPhoneBtn = document.querySelector("#view-phone");
  const viewMachineBtn = document.querySelector("#view-machine");
  const flipTitle = document.querySelector("#flip-title");
  const flipSub = document.querySelector("#flip-sub");

  const setSealed = (sealed) => {
    if (
      !backupBox ||
      !viewPhoneBtn ||
      !viewMachineBtn ||
      !flipTitle ||
      !flipSub
    )
      return;
    backupBox.dataset.sealed = String(sealed);
    viewPhoneBtn.setAttribute("aria-pressed", String(!sealed));
    viewMachineBtn.setAttribute("aria-pressed", String(sealed));
    flipTitle.textContent = sealed
      ? "On your backup machine (completely blind)"
      : "On your phone (sole writer)";
    flipSub.textContent = sealed
      ? "Your laptop or NAS holds only opaque sealed files under random-looking names—it cannot read a word or a filename."
      : "Fast, readable, works completely offline—even with 90,000 photos.";
  };

  viewPhoneBtn?.addEventListener("click", () => setSealed(false));
  viewMachineBtn?.addEventListener("click", () => setSealed(true));
})();
