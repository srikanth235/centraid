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
 * host — wave 1 is Google ×4 (read-only ingest) + GitHub via PAT.
 */

export interface ProviderPreset {
  readonly id: string;
  readonly name: string;
  readonly credKind: 'oauth2' | 'api_key';
  readonly authUrl?: string;
  readonly tokenUrl?: string;
  /** Everything wave-1 connectors need, pre-joined; trim to taste. */
  readonly scopes?: string;
  readonly allowedHosts: readonly string[];
  /** Owner-facing one-time setup walkthrough, in order. */
  readonly setup: readonly string[];
  /** Bundled connector templates this credential unlocks. */
  readonly connectors: readonly { templateId: string; kind: string; scope?: string }[];
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
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
  },
  {
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
  },
];
