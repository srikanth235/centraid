import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installAppTemplate,
  loadAppTemplates,
  loadAutomationTemplates,
  loadOverviewSuggestions,
  surfaceMintedWebhook,
} from './templatesData.js';

// `vi.hoisted` lifts these mock fns above the hoisted `vi.mock` factory so it can
// close over them without a TDZ error, keeping the real imports first.
const { listTemplates, gwCloneTemplate, gwInstallTemplate } = vi.hoisted(() => ({
  listTemplates: vi.fn(),
  gwCloneTemplate: vi.fn(),
  gwInstallTemplate: vi.fn(),
}));
vi.mock('../../../gateway-client.js', () => ({
  listTemplates: () => listTemplates(),
  cloneTemplate: (a: unknown) => gwCloneTemplate(a),
  installTemplate: (a: unknown) => gwInstallTemplate(a),
}));

const app = {
  id: 'todos',
  name: 'Todos',
  kind: 'app',
  colorKey: 'blue',
  iconKey: 'Todo',
  desc: 'd',
  version: '1',
};
const auto = {
  id: 'digest',
  name: 'Digest',
  kind: 'automation',
  colorKey: 'teal',
  iconKey: 'Bolt',
  desc: 'd',
  version: '1',
};

beforeEach(() => {
  listTemplates.mockReset();
  gwCloneTemplate.mockReset();
  gwInstallTemplate.mockReset();
});

describe('templatesData', () => {
  it('loadAppTemplates keeps only non-automation entries', async () => {
    listTemplates.mockResolvedValue([app, auto]);
    expect((await loadAppTemplates()).map((t) => t.id)).toEqual(['todos']);
  });

  it('loadAutomationTemplates keeps only automation entries', async () => {
    listTemplates.mockResolvedValue([app, auto]);
    expect((await loadAutomationTemplates()).map((t) => t.id)).toEqual(['digest']);
  });

  it('loadAutomationTemplates passes data/condition triggerKind through unchanged', async () => {
    const dataAuto = { ...auto, id: 'photo-captioner', triggerKind: 'data' };
    const conditionAuto = { ...auto, id: 'renewal-reminders', triggerKind: 'condition' };
    listTemplates.mockResolvedValue([app, dataAuto, conditionAuto]);
    const result = await loadAutomationTemplates();
    expect(result.map((t) => t.triggerKind)).toEqual(['data', 'condition']);
  });

  it('returns [] when the catalog fetch fails', async () => {
    listTemplates.mockRejectedValue(new Error('offline'));
    expect(await loadAppTemplates()).toEqual([]);
    expect(await loadAutomationTemplates()).toEqual([]);
    expect(await loadOverviewSuggestions()).toEqual([]);
  });

  it('loadOverviewSuggestions prefers curated ids and caps the list', async () => {
    listTemplates.mockResolvedValue([
      app,
      { ...auto, id: 'z-other', name: 'Other', desc: 'other' },
      {
        ...auto,
        id: 'obligation-extractor',
        name: 'Document deadlines',
        desc: 'Extract due dates',
        triggerLabel: 'On document',
      },
      { ...auto, id: 'google-gmail-pull', name: 'Gmail sync', desc: 'Pull mail' },
    ]);
    const rows = await loadOverviewSuggestions(3);
    expect(rows.map((r) => r.id)).toEqual(['obligation-extractor', 'google-gmail-pull']);
    expect(rows[0]).toMatchObject({
      name: 'Document deadlines',
      desc: 'Extract due dates',
      triggerLabel: 'On document',
    });
  });

  it('loadOverviewSuggestions falls back to catalog order when curated ids are missing', async () => {
    listTemplates.mockResolvedValue([
      { ...auto, id: 'alpha', name: 'Alpha', desc: 'a' },
      { ...auto, id: 'beta', name: 'Beta', desc: 'b' },
      { ...auto, id: 'gamma', name: 'Gamma', desc: 'c' },
      { ...auto, id: 'delta', name: 'Delta', desc: 'd' },
    ]);
    const rows = await loadOverviewSuggestions(3);
    expect(rows.map((r) => r.id)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('installAppTemplate installs in place (keeps the blueprint id) and shapes a Home pin — no draft flag, no clone', async () => {
    gwInstallTemplate.mockResolvedValue({
      app: {
        id: 'todos',
        name: 'Todos',
        description: 'in place',
        iconKey: 'Todo',
        colorKey: 'blue',
      },
      alreadyInstalled: false,
    });
    const pin = await installAppTemplate(app as never);
    expect(gwInstallTemplate).toHaveBeenCalledWith({ templateId: 'todos' });
    expect(gwCloneTemplate).not.toHaveBeenCalled();
    expect(pin).toMatchObject({
      centraidAppId: 'todos',
      id: 'todos',
      name: 'Todos',
      desc: 'in place',
    });
    expect((pin as unknown as { __draft?: boolean }).__draft).toBeUndefined();
    expect(pin.createdAt).toBeTruthy();
    expect(pin.updatedAt).toBeTruthy();
  });

  it('falls back to the template name/desc when the install response omits them', async () => {
    gwInstallTemplate.mockResolvedValue({ app: { id: 'todos' }, alreadyInstalled: true });
    const pin = await installAppTemplate(app as never);
    expect(pin.name).toBe('Todos');
    expect(pin.desc).toBe('d');
  });

  it('surfaceMintedWebhook logs the URL + plaintext secret as a dev-console fallback', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    surfaceMintedWebhook({ url: 'https://gw.example/_centraid-hook/abc', secret: 'shh' });
    expect(spy).toHaveBeenCalledTimes(1);
    const [line] = spy.mock.calls[0] as [string];
    expect(line).toContain('https://gw.example/_centraid-hook/abc');
    expect(line).toContain('shh');
    spy.mockRestore();
  });
});
