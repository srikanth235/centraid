/**
 * Provider presets — the BYO-client wizard content (issue #304 decision 7).
 * Each preset carries everything `sync.configure_credential` needs except
 * the owner's own client_id/secret (that is the point: each owner registers
 * their OWN OAuth client — no shared Centraid app, no verification burden),
 * plus the agent-guided setup walkthrough with the known traps baked in:
 * Google's Testing-status 7-day refresh-token expiry, and the Photos API
 * restriction (Takeout/file-drop is the photos lane, not OAuth).
 *
 * `connectors` names which bundled connector template rides which scope +
 * host. `capabilities` declares syncs (pull blueprints) and actions
 * (send/tool ops) the UI and assistant can surface without secrets.
 */

export interface ProviderConnectorRef {
  readonly templateId: string;
  readonly kind: string;
  readonly scope?: string;
}

/** Scheduled ingest capability — maps to a pull blueprint automation. */
export interface ProviderSyncCapability {
  readonly id: string;
  readonly title: string;
  readonly templateId: string;
  readonly kind: string;
  readonly defaultCron: string;
  readonly scope?: string;
}

/** On-demand operation — agent tool and/or send automation. */
export interface ProviderActionCapability {
  readonly id: string;
  readonly title: string;
  /** Stable tool name for the assistant registry (no secrets). */
  readonly toolName: string;
  readonly kind: string;
  readonly templateId?: string;
  readonly approval?: 'outbox';
  readonly scope?: string;
}

export interface ProviderCapabilities {
  readonly syncs: readonly ProviderSyncCapability[];
  readonly actions: readonly ProviderActionCapability[];
}

export interface ProviderPreset {
  readonly id: string;
  readonly name: string;
  readonly credKind: 'oauth2' | 'api_key';
  readonly authUrl?: string;
  readonly tokenUrl?: string;
  /** Everything connectors need, pre-joined; trim to taste. */
  readonly scopes?: string;
  readonly allowedHosts: readonly string[];
  /** Owner-facing one-time setup walkthrough, in order. */
  readonly setup: readonly string[];
  /** Bundled connector templates this credential unlocks. */
  readonly connectors: readonly ProviderConnectorRef[];
  /** Declared syncs + actions derived from connectors (+ optional extras). */
  readonly capabilities: ProviderCapabilities;
}

function humanizeKind(kind: string): string {
  const tail = kind.includes('.') ? kind.slice(kind.indexOf('.') + 1) : kind;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

function titleFromTemplate(templateId: string, kind: string): string {
  const base = templateId
    .replace(/-pull$/, '')
    .replace(/-send$/, '')
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
  return base || humanizeKind(kind);
}

/** Build capability lists from connector refs (pull → sync, *-send → action). */
export function capabilitiesFromConnectors(
  connectors: readonly ProviderConnectorRef[],
  extras?: { actions?: readonly ProviderActionCapability[] },
): ProviderCapabilities {
  const syncs: ProviderSyncCapability[] = [];
  const actions: ProviderActionCapability[] = [];
  for (const c of connectors) {
    if (c.templateId.endsWith('-send')) {
      actions.push({
        id: `action:${c.templateId}`,
        title: titleFromTemplate(c.templateId, c.kind),
        // Send templates can share a connection kind (Gmail mail + calendar
        // invite), so the template id—not kind—is the collision-free key.
        toolName: `connector.${c.templateId.replace(/-/g, '_')}`,
        kind: c.kind,
        templateId: c.templateId,
        approval: 'outbox',
        ...(c.scope ? { scope: c.scope } : {}),
      });
      continue;
    }
    syncs.push({
      id: `sync:${c.templateId}`,
      title: `${titleFromTemplate(c.templateId, c.kind)} sync`,
      templateId: c.templateId,
      kind: c.kind,
      defaultCron: '0 * * * *',
      ...(c.scope ? { scope: c.scope } : {}),
    });
    // Every live pull also exposes a read tool for the assistant.
    actions.push({
      id: `action:list:${c.kind}`,
      title: `List recent ${humanizeKind(c.kind)}`,
      toolName: `connector.${c.kind.replace(/\./g, '_')}.list`,
      kind: c.kind,
      templateId: c.templateId,
      ...(c.scope ? { scope: c.scope } : {}),
    });
  }
  if (extras?.actions) actions.push(...extras.actions);
  return { syncs, actions };
}

function preset(
  base: Omit<ProviderPreset, 'capabilities'> & {
    capabilities?: ProviderCapabilities;
  },
): ProviderPreset {
  return {
    ...base,
    capabilities: base.capabilities ?? capabilitiesFromConnectors(base.connectors),
  };
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  preset({
    id: 'google',
    name: 'Google (Gmail, Calendar, Contacts, Drive)',
    credKind: 'oauth2',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      // gmail.send (not the broader gmail.modify) — outbound only, never
      // reads or deletes existing mail. Unlocks the outbox-staged sends
      // below (google-gmail-send, google-calendar-invite-send); every
      // actual send still parks for the owner's approval regardless.
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/contacts.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ].join(' '),
    allowedHosts: [
      'gmail.googleapis.com',
      'people.googleapis.com',
      'www.googleapis.com',
      'oauth2.googleapis.com',
    ],
    setup: [
      'Open https://console.cloud.google.com and create a project (any name, e.g. "my-centraid").',
      'APIs & Services → Library: enable the Gmail API, Google Calendar API, People API and Google Drive API.',
      'APIs & Services → OAuth consent screen: choose External, fill in the app name and your email, save.',
      'IMPORTANT — Publishing status: press "Publish app" so the status reads **In production**, not Testing. In Testing status Google expires your refresh token every 7 days and the connection silently dies weekly; unverified-production only means one "unverified app" warning screen that you click through once (Advanced → continue).',
      'APIs & Services → Credentials → Create credentials → OAuth client ID → type **Web application**. Add the redirect URI Centraid shows you on the Connect screen, then copy the Client ID and Client secret here.',
      'Note: Google Photos is NOT reachable this way — Google restricted the Photos API in 2025 to app-created content. Photos come in via Takeout file-drop, which Centraid already imports.',
    ],
    connectors: [
      {
        templateId: 'google-gmail-pull',
        kind: 'pull.gmail',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      },
      {
        templateId: 'google-calendar-pull',
        kind: 'pull.gcal',
        scope: 'https://www.googleapis.com/auth/calendar.readonly',
      },
      {
        templateId: 'google-contacts-pull',
        kind: 'pull.gcontacts',
        scope: 'https://www.googleapis.com/auth/contacts.readonly',
      },
      {
        templateId: 'google-drive-pull',
        kind: 'pull.gdrive',
        scope: 'https://www.googleapis.com/auth/drive.readonly',
      },
      {
        templateId: 'google-gmail-send',
        kind: 'pull.gmail',
        scope: 'https://www.googleapis.com/auth/gmail.send',
      },
      {
        templateId: 'google-calendar-invite-send',
        kind: 'pull.gmail',
        scope: 'https://www.googleapis.com/auth/gmail.send',
      },
    ],
  }),
  preset({
    id: 'microsoft',
    name: 'Microsoft 365 (Outlook, Calendar, Contacts, OneDrive)',
    credKind: 'oauth2',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: [
      'offline_access',
      'User.Read',
      'Mail.Read',
      'Calendars.Read',
      'Contacts.Read',
      'Files.Read',
    ].join(' '),
    allowedHosts: ['graph.microsoft.com', 'login.microsoftonline.com'],
    setup: [
      'Open https://portal.azure.com → Microsoft Entra ID → App registrations → New registration.',
      'Name it (e.g. "my-centraid"), set supported account types to "Accounts in any organizational directory and personal Microsoft accounts", and add the redirect URI Centraid shows you (Web).',
      'Certificates & secrets → New client secret — copy the Value once (it is not shown again).',
      'API permissions → Add → Microsoft Graph → delegated: User.Read, Mail.Read, Calendars.Read, Contacts.Read, Files.Read. Grant admin consent only if your tenant requires it for personal use it is usually optional.',
      'Overview → copy Application (client) ID here with the client secret. Sign in with the Microsoft account whose mail/calendar you want in the vault.',
    ],
    connectors: [
      {
        templateId: 'microsoft-outlook-pull',
        kind: 'pull.outlook',
        scope: 'Mail.Read offline_access User.Read',
      },
      {
        templateId: 'microsoft-calendar-pull',
        kind: 'pull.outlookcal',
        scope: 'Calendars.Read offline_access User.Read',
      },
      {
        templateId: 'microsoft-contacts-pull',
        kind: 'pull.outlookcontacts',
        scope: 'Contacts.Read offline_access User.Read',
      },
      {
        templateId: 'microsoft-onedrive-pull',
        kind: 'pull.onedrive',
        scope: 'Files.Read offline_access User.Read',
      },
    ],
  }),
  preset({
    id: 'github',
    name: 'GitHub (repos, issues, PRs)',
    credKind: 'api_key',
    allowedHosts: ['api.github.com'],
    setup: [
      'Open https://github.com/settings/personal-access-tokens and create a fine-grained personal access token.',
      'Scope it to the repositories you want in the vault, with read-only permissions (Contents, Issues, Pull requests, Metadata).',
      'Set a long expiry (or no expiry) — when the token does expire, the connection flips to needs-auth and tells you.',
      'Paste the token here as the credential. No OAuth dance needed — this is the whole setup.',
    ],
    connectors: [{ templateId: 'github-pull', kind: 'pull.github' }],
  }),
  preset({
    id: 'gitlab',
    name: 'GitLab (issues, merge requests)',
    credKind: 'api_key',
    allowedHosts: ['gitlab.com'],
    setup: [
      'Open https://gitlab.com/-/user_settings/personal_access_tokens (or your self-managed instance equivalent).',
      'Create a token with read_api (or the finer read_api scope covering issues and merge requests).',
      'Paste the token here. Self-hosted GitLab needs a host pin change later — this preset targets gitlab.com.',
    ],
    connectors: [{ templateId: 'gitlab-pull', kind: 'pull.gitlab' }],
  }),
  preset({
    id: 'linear',
    name: 'Linear (issues)',
    credKind: 'api_key',
    allowedHosts: ['api.linear.app'],
    setup: [
      'Open Linear → Settings → Account → Security & access → Personal API keys.',
      'Create a key with read access to the workspaces you want in the vault.',
      'Paste the key here. Linear uses GraphQL; the connector only lists issues you can already see.',
    ],
    connectors: [{ templateId: 'linear-pull', kind: 'pull.linear' }],
  }),
  preset({
    id: 'notion',
    name: 'Notion (pages)',
    credKind: 'api_key',
    allowedHosts: ['api.notion.com'],
    setup: [
      'Open https://www.notion.so/my-integrations and create an internal integration.',
      'Copy the Internal Integration Secret.',
      'In each Notion page or database you want synced, click ··· → Connections → connect your integration (tokens only see pages you explicitly share).',
      'Paste the secret here.',
    ],
    connectors: [{ templateId: 'notion-pull', kind: 'pull.notion' }],
  }),
  preset({
    id: 'todoist',
    name: 'Todoist (tasks)',
    credKind: 'api_key',
    allowedHosts: ['api.todoist.com'],
    setup: [
      'Open https://todoist.com/app/settings/integrations/developer.',
      'Copy your API token (REST v2).',
      'Paste it here. The connector lists active tasks only — completed history is not bulk-imported.',
    ],
    connectors: [{ templateId: 'todoist-pull', kind: 'pull.todoist' }],
  }),
  preset({
    id: 'slack',
    name: 'Slack (conversations)',
    credKind: 'api_key',
    allowedHosts: ['slack.com', 'www.slack.com'],
    setup: [
      'Create a Slack app at https://api.slack.com/apps (From scratch) in the workspace you want to read.',
      'OAuth & Permissions → User Token Scopes: channels:history, channels:read, groups:history, groups:read, im:history, im:read, mpim:history, mpim:read, users:read.',
      'Install to workspace and copy the User OAuth Token (starts with xoxp-). Bot tokens (xoxb-) work for channels the bot is in; user tokens cover your DMs.',
      'Paste the token here. This is read-only — the connector never posts.',
    ],
    connectors: [{ templateId: 'slack-pull', kind: 'pull.slack' }],
  }),
  preset({
    id: 'dropbox',
    name: 'Dropbox (files)',
    credKind: 'oauth2',
    authUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    // Dropbox token endpoint expects the app key/secret; scopes are set on the app.
    scopes: 'files.metadata.read account_info.read',
    allowedHosts: ['api.dropboxapi.com', 'content.dropboxapi.com', 'www.dropbox.com'],
    setup: [
      'Open https://www.dropbox.com/developers/apps → Create app → Scoped access → Full Dropbox (or App folder if you prefer a sandbox).',
      'Permissions: enable files.metadata.read and account_info.read. Submit permissions if prompted.',
      'Settings → OAuth 2 → add the redirect URI Centraid shows you. Copy the App key (client id) and App secret.',
      'Paste them here and authorize. The connector lists folder metadata only — it does not download file bytes.',
    ],
    connectors: [{ templateId: 'dropbox-pull', kind: 'pull.dropbox' }],
  }),
];
