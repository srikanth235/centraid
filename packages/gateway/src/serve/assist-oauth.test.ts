import { describe, expect, test } from 'vitest';
import {
  ASSIST_DEVELOPMENT_WORKER_ORIGIN,
  ASSIST_PRODUCTION_CALLBACK_URL,
  ASSIST_PRODUCTION_WORKER_ORIGIN,
  assistCallbackUrl,
  assistOAuthFromEnvironment,
  assistScopes,
  validateAssistOAuthConfig,
} from './assist-oauth.js';

const CLIENT_ID = 'centraid-shared-client.apps.googleusercontent.com';

describe('Assist host configuration', () => {
  test('is absent unless both public coordinates are configured', () => {
    expect(assistOAuthFromEnvironment({})).toBeUndefined();
    expect(() =>
      assistOAuthFromEnvironment({ CENTRAID_ASSIST_GOOGLE_CLIENT_ID: CLIENT_ID }),
    ).toThrow(/requires both/);
  });

  test('accepts the production origin and exact loopback development origins only', () => {
    const production = assistOAuthFromEnvironment({
      CENTRAID_ASSIST_GOOGLE_CLIENT_ID: CLIENT_ID,
      CENTRAID_ASSIST_OAUTH_WORKER_URL: ASSIST_PRODUCTION_WORKER_ORIGIN,
    });
    expect(production).toMatchObject({
      workerBaseUrl: ASSIST_PRODUCTION_WORKER_ORIGIN,
      restrictedScopesEnabled: false,
    });
    expect(assistCallbackUrl(production!)).toBe(ASSIST_PRODUCTION_CALLBACK_URL);
    expect(
      validateAssistOAuthConfig({
        workerBaseUrl: ASSIST_DEVELOPMENT_WORKER_ORIGIN,
        googleClientId: CLIENT_ID,
        restrictedScopesEnabled: false,
      }).workerBaseUrl,
    ).toBe(ASSIST_DEVELOPMENT_WORKER_ORIGIN);
    for (const workerBaseUrl of [
      'https://oauth.example',
      'https://oauth.centraid.dev.evil.example',
      'http://localhost:8787',
      'http://127.0.0.1:8788',
    ]) {
      expect(() =>
        validateAssistOAuthConfig({
          workerBaseUrl,
          googleClientId: CLIENT_ID,
          restrictedScopesEnabled: false,
        }),
      ).toThrow(/must be https:\/\/oauth\.centraid\.dev/);
    }
  });
});

describe('Assist scope tiers', () => {
  test('requests only selected standard scopes and rejects identity/restricted scopes by default', () => {
    const config = {
      workerBaseUrl: ASSIST_PRODUCTION_WORKER_ORIGIN,
      googleClientId: CLIENT_ID,
      restrictedScopesEnabled: false,
    };
    expect(
      assistScopes(
        [
          'https://www.googleapis.com/auth/calendar.readonly',
          'https://www.googleapis.com/auth/calendar.readonly',
          'https://www.googleapis.com/auth/contacts.readonly',
        ],
        config,
      ),
    ).toEqual([
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/contacts.readonly',
    ]);
    expect(() => assistScopes(['openid'], config)).toThrow(/not part of a Centraid Assist tier/);
    expect(() => assistScopes(['https://www.googleapis.com/auth/gmail.readonly'], config)).toThrow(
      /verification/,
    );
  });

  test('restricted scopes remain behind the explicit verified-release assertion', () => {
    expect(
      assistScopes(['https://www.googleapis.com/auth/gmail.readonly'], {
        workerBaseUrl: ASSIST_PRODUCTION_WORKER_ORIGIN,
        googleClientId: CLIENT_ID,
        restrictedScopesEnabled: true,
      }),
    ).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
  });
});
