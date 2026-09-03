import type { JSX } from "react";

import type { TemplateEntry } from "../../../app-shell-context.js";
import type { CatalogTemplate } from "../../screen-contracts.js";
import AutomationTemplatesScreen from "../../screens/AutomationTemplatesScreen.js";
import { useShellActions } from "../actions.js";
import { openAutomationTemplatePreview } from "../automationTemplatePreview.js";
import PageScroll from "../PageScroll.js";
import { PageEmpty, PageLoading } from "../status.js";
import { useAsyncData } from "../useAsyncData.js";
import { openWebhookReveal } from "../webhookReveal.js";
import {
  cloneAutomationTemplate,
  loadAutomationTemplates,
  surfaceMintedWebhook,
} from "./templatesData.js";

export default function TemplatesRoute(): JSX.Element {
  const { navigate, showToast } = useShellActions();
  const state = useAsyncData(() => loadAutomationTemplates());

  const useAutoTemplate = (t: TemplateEntry): void => {
    void cloneAutomationTemplate(t)
      .then(async ({ ref, webhooks }) => {
        const revealNext = async (index: number): Promise<void> => {
          const webhook = webhooks[index];
          if (!webhook) return;
          surfaceMintedWebhook(webhook);
          await openWebhookReveal(webhook);
          return revealNext(index + 1);
        };
        await revealNext(0);
        if (ref) navigate({ kind: "automation-view", automationId: ref });
        else navigate({ kind: "automations" });
      })
      .catch((error: unknown) =>
        showToast(
          `Could not adopt template: ${error instanceof Error ? error.message : String(error)}`
        )
      );
  };

  const onStartFromScratch = (): void => {
    navigate({ kind: "automation-editor" });
  };

  return (
    <PageScroll>
      {state.status === "loading" ? (
        <PageLoading label="Loading templates…" />
      ) : state.status === "error" ? (
        <PageEmpty message={`Couldn’t load templates: ${state.error}`} />
      ) : (
        <AutomationTemplatesScreen
          templates={state.data as unknown as CatalogTemplate[]}
          subtitle="Proven automations, pre-wired with triggers and integrations."
          onPreview={(t) =>
            openAutomationTemplatePreview(
              t as unknown as TemplateEntry,
              useAutoTemplate
            )
          }
          onStartFromScratch={onStartFromScratch}
        />
      )}
    </PageScroll>
  );
}
