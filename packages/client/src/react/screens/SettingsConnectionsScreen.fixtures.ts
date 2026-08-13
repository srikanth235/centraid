// Fixture builders for the Connections screen's tests.
//
// Split out of `SettingsConnectionsScreen.test.tsx` (#765), which crossed the
// repo's 625-line ceiling. These two are the file's only stateless pieces —
// everything else there closes over the per-test root/verbs/signals — so they
// are what can move without threading harness state through a second module.

import type {
  ConnectionRowDTO,
  ProviderOptionDTO,
} from "./SettingsConnectionsScreen.js";

export function makeRow(
  over: Partial<ConnectionRowDTO> = {}
): ConnectionRowDTO {
  return {
    authNote: null,
    connectionId: "c1",
    credKind: "oauth2",
    health: "needs-auth",
    kind: "pull.gmail",
    label: "Google · Gmail",
    lastRunAt: null,
    principal: null,
    provider: "google",
    ...over,
  };
}

export function makeProvider(
  over: Partial<ProviderOptionDTO> = {}
): ProviderOptionDTO {
  return {
    allowedHosts: ["gmail.googleapis.com"],
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    capabilities: {
      actions: [
        {
          id: "action:list:pull.gmail",
          kind: "pull.gmail",
          title: "List Gmail",
          toolName: "connector.pull_gmail.list",
        },
      ],
      syncs: [
        {
          defaultCron: "0 * * * *",
          id: "sync:google-gmail-pull",
          kind: "pull.gmail",
          templateId: "google-gmail-pull",
          title: "Gmail sync",
        },
      ],
    },
    connectors: [
      {
        kind: "pull.gmail",
        scope: "gmail.readonly",
        templateId: "google-gmail-pull",
      },
      {
        kind: "pull.gcal",
        scope: "calendar.events",
        templateId: "google-calendar-pull",
      },
    ],
    credKind: "oauth2",
    id: "google",
    name: "Google (Gmail, Calendar, Contacts, Drive)",
    scopes: "gmail.readonly calendar.events",
    setup: ["Open https://console.cloud.google.com and create a project."],
    tokenUrl: "https://oauth2.googleapis.com/token",
    ...over,
  };
}
