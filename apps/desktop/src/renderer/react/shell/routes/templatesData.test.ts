import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installAppTemplate, loadAppTemplates, loadAutomationTemplates } from './templatesData.js';

// `vi.hoisted` lifts these mock fns above the hoisted `vi.mock` factory so it can
// close over them without a TDZ error, keeping the real imports first.
const { listTemplates, gwCloneTemplate } = vi.hoisted(() => ({
  listTemplates: vi.fn(),
  gwCloneTemplate: vi.fn(),
}));
vi.mock('../../../gateway-client.js', () => ({
  listTemplates: () => listTemplates(),
  cloneTemplate: (a: unknown) => gwCloneTemplate(a),
}));

const app = { id: 'todos', name: 'Todos', kind: 'app', colorKey: 'blue', iconKey: 'Todo', desc: 'd', version: '1' };
const auto = { id: 'digest', name: 'Digest', kind: 'automation', colorKey: 'teal', iconKey: 'Bolt', desc: 'd', version: '1' };

beforeEach(() => {
  listTemplates.mockReset();
  gwCloneTemplate.mockReset();
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

  it('returns [] when the catalog fetch fails', async () => {
    listTemplates.mockRejectedValue(new Error('offline'));
    expect(await loadAppTemplates()).toEqual([]);
    expect(await loadAutomationTemplates()).toEqual([]);
  });

  it('installAppTemplate clones and shapes a Home pin from the result — no draft flag', async () => {
    gwCloneTemplate.mockResolvedValue({
      app: { id: 'todos-2', name: 'Todos 2', description: 'cloned' },
      template: { name: 'Todos' },
    });
    const pin = await installAppTemplate(app as never);
    expect(gwCloneTemplate).toHaveBeenCalledWith({ templateId: 'todos' });
    expect(pin).toMatchObject({
      centraidAppId: 'todos-2',
      id: 'todos-2',
      name: 'Todos 2',
      desc: 'cloned',
    });
    expect((pin as unknown as { __draft?: boolean }).__draft).toBeUndefined();
    expect(pin.createdAt).toBeTruthy();
    expect(pin.updatedAt).toBeTruthy();
  });

  it('falls back to the template name when the clone omits app.name', async () => {
    gwCloneTemplate.mockResolvedValue({ app: { id: 'x' }, template: { name: 'Fallback' } });
    const pin = await installAppTemplate(app as never);
    expect(pin.name).toBe('Fallback');
  });
});
