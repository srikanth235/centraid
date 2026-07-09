// Automation templates gallery — the browsable catalog of automation
// blueprints, each previewable and one-tap adoptable into the conversational
// builder. Split out of app-automations.ts. Self-contained: it reaches the
// shell through ShellContext primitives and routes adoption through
// ctx.shell.{enterAutomationBuilder,createAndOpenAutomationBuilder}.
//
// The React AutomationTemplatesScreen renders the gallery; the preview drawer
// stays vanilla (a body-level modal opened through its onPreview callback).
import { cloneTemplate as gwCloneTemplate, listTemplates } from './gateway-client.js';
import { isAutomationTemplate } from './app-format.js';
import { INTEGRATION_HUES } from './app-automations-ui.js';
import { requireReactBridge } from './react/bridge.js';
import type { ShellContext, TemplateEntry } from './app-shell-context.js';

export interface TemplatesGalleryModule {
  renderAutomationTemplates(): void;
  openAutomationTemplatePreview(template: TemplateEntry): void;
  loadAutomationTemplates(): Promise<TemplateEntry[]>;
}

export function createTemplatesGallery(ctx: ShellContext): TemplatesGalleryModule {
  const { el, clear, showToast, recordRoute, registerCleanup, pageScroll, mountShellPage } = ctx;

  // The automation slice of the unified template catalog (Discover reuses this
  // loader via the module's exposed binding).
  async function loadAutomationTemplates(): Promise<TemplateEntry[]> {
    try {
      const all = (await listTemplates()) as TemplateEntry[];
      return all.filter(isAutomationTemplate);
    } catch {
      return [];
    }
  }

  // A row of integration chips — colored dot + name.
  function renderIntegrationChips(integrations: readonly string[]): HTMLElement {
    const wrap = el('div', { class: 'cd-au-chips' });
    for (const name of integrations) {
      const hue = INTEGRATION_HUES[name] ?? 'slate';
      const dot = el('i', { class: 'cd-au-chip-dot', 'aria-hidden': 'true' });
      dot.style.background = `var(--c-${hue})`;
      wrap.append(el('span', { class: 'cd-au-chip' }, [dot, name]));
    }
    return wrap;
  }

  // Preview drawer — a right-side panel describing an automation template
  // before adopting it. "Use template" routes into the conversational builder
  // pre-seeded. (Distinct from the home shelf's centered app-template modal,
  // `openTemplatePreview`.) Stays vanilla — a body-level modal.
  function openAutomationTemplatePreview(template: TemplateEntry): void {
    const integrations = template.integrations ?? [];
    const trigIcon =
      template.triggerKind === 'webhook' ? Icon.Webhook({ size: 14 }) : Icon.Clock({ size: 14 });
    const backdrop = el('div', { class: 'cd-au-drawer-backdrop' });
    const panel = el('div', {
      class: 'cd-au-drawer',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': `${template.name} template`,
    });
    const close = (): void => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
    };
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });

    const stepsList = el('ul', { class: 'cd-au-drawer-steps' });
    for (const line of [
      `Fires ${template.triggerLabel ?? 'on a trigger'}.`,
      template.desc,
      integrations.length > 0
        ? `Works through ${integrations.join(', ')}.`
        : 'Runs with the workspace default tools.',
    ]) {
      stepsList.append(el('li', {}, line));
    }

    const useBtn = el('button', {
      class: 'cd-au-btn cd-au-btn-primary',
      type: 'button',
      trustedHtml: `<span>Use template</span>${Icon.ArrowRight({ size: 14 })}`,
      onClick: () => {
        close();
        void adoptTemplate(template);
      },
    });

    panel.append(
      el('div', { class: 'cd-au-drawer-head' }, [
        el('span', { class: 'cd-au-drawer-emoji' }, template.emoji ?? '⚙️'),
        el('div', {}, [
          el('div', { class: 'cd-au-drawer-name' }, template.name),
          el('div', { class: 'cd-au-drawer-trig' }, [
            el('span', { 'aria-hidden': 'true', trustedHtml: trigIcon }),
            template.triggerLabel ?? 'Manual',
          ]),
        ]),
        el('button', {
          class: 'cd-au-drawer-close',
          type: 'button',
          'aria-label': 'Close',
          trustedHtml: Icon.X({ size: 16 }),
          onClick: close,
        }),
      ]),
      el('div', { class: 'cd-au-drawer-body' }, [
        el('div', { class: 'cd-au-drawer-sec-l' }, 'What it does'),
        stepsList,
        ...(integrations.length > 0
          ? [
              el('div', { class: 'cd-au-drawer-sec-l' }, 'Connects'),
              renderIntegrationChips([...integrations]),
            ]
          : []),
      ]),
      el('div', { class: 'cd-au-drawer-foot' }, [useBtn]),
    );
    backdrop.append(panel);
    document.body.append(backdrop);
  }

  // Renders the Automations → "Browse templates" gallery via the React screen.
  // Cards open the preview drawer above; "Use template" routes through
  // `cloneTemplate` (the same IPC the home shelf uses).
  function renderAutomationTemplates(): void {
    recordRoute({ kind: 'templates' });
    clear();
    const { main, scroll } = pageScroll(
      'Templates',
      'Proven automations, pre-wired with triggers and integrations. Adopt one and tune it to your workflow.',
    );
    scroll.append(el('div', { class: 'cd-au-loading' }, 'Loading templates…'));
    mountShellPage('automations', main);

    void loadAutomationTemplates().then((tmpls) => {
      const host = el('div');
      scroll.replaceChildren(host);
      registerCleanup(
        requireReactBridge().mountAutomationTemplates(host, {
          onPreview: (t) => openAutomationTemplatePreview(t),
          onStartFromScratch: () => void ctx.shell.createAndOpenAutomationBuilder(),
          templates: tmpls,
        }),
      );
    });
  }

  // Adopting an automation template goes through the same `cloneTemplate`
  // IPC as the home-shelf "Use template" button — one code path for both
  // kinds. The IPC handles suffix-aware id+name picking, copies the
  // template's `<slug>/automations/<slug>/{automation.json,handler.js}`
  // into the user's appsDir as `<slug>-N/`, and mints any pending
  // webhook secrets. The user then lands in the automation builder where
  // the agent will tune the handler from the manifest's `prompt`.
  async function adoptTemplate(template: TemplateEntry): Promise<void> {
    try {
      const result = await gwCloneTemplate({ templateId: template.id });
      // Webhook secrets are returned exactly once. v1 surfaces a toast;
      // a follow-up can show a proper "copy this URL + secret" sheet.
      for (const w of result.webhooks ?? []) {
        showToast(`Webhook URL: ${w.url} (secret shown once in console)`);
        // eslint-disable-next-line no-console -- grandfathered pre-existing suppression (#247)
        console.info(`[clone] webhook secret for ${w.ownerApp}/${w.automationId}:`, w.secret);
      }
      ctx.shell.enterAutomationBuilder({ automationId: result.app.id });
    } catch (err) {
      showToast(`Could not adopt template: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { renderAutomationTemplates, openAutomationTemplatePreview, loadAutomationTemplates };
}
