import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SettingsStorageScreen, {
  type SettingsStorageBridgeProps,
  type StorageConnectionRowDTO,
} from './SettingsStorageScreen.js';

function makeRow(over: Partial<StorageConnectionRowDTO> = {}): StorageConnectionRowDTO {
  return {
    id: 'c1',
    kind: 'byo-s3',
    name: 'My Bucket',
    uses: ['backup', 'cas'],
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: 'my-bucket',
    ...over,
  };
}

function makeProps(over: Partial<SettingsStorageBridgeProps> = {}): SettingsStorageBridgeProps {
  return {
    loadConnections: vi.fn().mockResolvedValue([makeRow()]),
    createConnection: vi.fn().mockResolvedValue({ ok: true, value: makeRow() }),
    deleteConnection: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue({ ok: true, detail: 'signed request accepted' }),
    confirmRecoveryKit: vi.fn().mockResolvedValue({ confirmedAt: 1_700_000_000 }),
    loadVaultBlobStore: vi.fn().mockResolvedValue({ kind: 'fs' }),
    attachVaultConnection: vi.fn().mockResolvedValue({ ok: true, value: { kind: 's3', connectionId: 'c1' } }),
    detachVaultConnection: vi.fn().mockResolvedValue({ kind: 'fs' }),
    showToast: vi.fn(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

async function mount(props: SettingsStorageBridgeProps): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<SettingsStorageScreen {...props} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

const setNativeValue = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('SettingsStorageScreen — connection list', () => {
  it('renders a connection row with its kind/use badges and endpoint summary', async () => {
    const el = await mount(makeProps());
    expect(el.querySelectorAll('[data-testid="storage-connection-row"]').length).toBe(1);
    expect(el.textContent).toContain('My Bucket');
    expect(el.textContent).toContain('BYO S3');
    expect(el.textContent).toContain('s3.example.com');
  });

  it('shows the empty state when there are no connections', async () => {
    const el = await mount(makeProps({ loadConnections: vi.fn().mockResolvedValue([]) }));
    expect(el.textContent).toContain('No storage connections configured yet.');
  });

  it('Test connection shows the ok result inline', async () => {
    const el = await mount(makeProps());
    const testBtn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Test connection');
    await act(async () => testBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
    });
    const result = el.querySelector('[data-testid="storage-test-result"]');
    expect(result?.getAttribute('data-ok')).toBe('true');
    expect(result?.textContent).toContain('signed request accepted');
  });

  it('Test connection shows the error result inline', async () => {
    const props = makeProps({
      testConnection: vi.fn().mockResolvedValue({ ok: false, error: 'connection refused' }),
    });
    const el = await mount(props);
    const testBtn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Test connection');
    await act(async () => testBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
    });
    const result = el.querySelector('[data-testid="storage-test-result"]');
    expect(result?.getAttribute('data-ok')).toBe('false');
    expect(result?.textContent).toContain('connection refused');
  });

  it('Delete calls deleteConnection with id + name and refreshes', async () => {
    const props = makeProps();
    const el = await mount(props);
    const deleteBtn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Delete');
    await act(async () => deleteBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
    });
    expect(props.deleteConnection).toHaveBeenCalledWith('c1', 'My Bucket');
    expect(props.loadConnections).toHaveBeenCalledTimes(2); // initial + post-delete refresh
  });
});

describe('SettingsStorageScreen — add connection', () => {
  it('opens the add form and submits a byo-s3 connection', async () => {
    const props = makeProps({ loadConnections: vi.fn().mockResolvedValue([]) });
    const el = await mount(props);
    const addBtn = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Add connection'));
    await act(async () => addBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const fieldInput = (labelText: string): HTMLInputElement | null => {
      const field = [...el.querySelectorAll('.field')].find((f) =>
        f.querySelector('.fieldLabel')?.textContent?.includes(labelText),
      );
      return field?.querySelector('input') ?? null;
    };
    await act(async () => {
      setNativeValue(fieldInput('Name')!, 'Backup bucket');
      setNativeValue(fieldInput('Endpoint')!, 'https://s3.example.com');
      setNativeValue(fieldInput('Region')!, 'us-east-1');
      setNativeValue(fieldInput('Bucket')!, 'my-bucket');
      setNativeValue(fieldInput('Access key ID')!, 'AKIA123');
      setNativeValue(fieldInput('Secret access key')!, 'shh-secret');
    });

    const saveBtn = [...el.querySelectorAll('.wizard button')].find((b) =>
      b.textContent?.includes('Add connection'),
    );
    expect(saveBtn?.hasAttribute('disabled')).toBe(false);
    await act(async () => saveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
    });

    expect(props.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'byo-s3',
        name: 'Backup bucket',
        endpoint: 'https://s3.example.com',
        region: 'us-east-1',
        bucket: 'my-bucket',
        accessKeyId: 'AKIA123',
        secretAccessKey: 'shh-secret',
        uses: ['backup', 'cas'],
      }),
      undefined,
    );
    // Wizard closed on success.
    expect(el.querySelector('.wizard')).toBeNull();
  });

  it('switching to "Storage provider" shows baseUrl/apiKey fields instead', async () => {
    const el = await mount(makeProps());
    const addBtn = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Add connection'));
    await act(async () => addBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const providerToggle = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'Storage provider',
    );
    await act(async () => providerToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(el.textContent).toContain('Base URL');
    expect(el.textContent).toContain('API key');
    expect(el.textContent).not.toContain('Access key ID');
  });
});

describe('SettingsStorageScreen — recovery-kit gate', () => {
  it('shows the gate dialog when createConnection is refused, and "I\'ve saved my recovery kit" confirms then retries', async () => {
    const createConnection = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        code: 'recovery_kit_not_confirmed',
        message: 'confirm you have exported the recovery kit',
      })
      .mockResolvedValueOnce({ ok: true, value: makeRow() });
    const props = makeProps({ createConnection, loadConnections: vi.fn().mockResolvedValue([]) });
    const el = await mount(props);

    const addBtn = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Add connection'));
    await act(async () => addBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const fieldInput = (labelText: string): HTMLInputElement | null => {
      const field = [...el.querySelectorAll('.field')].find((f) =>
        f.querySelector('.fieldLabel')?.textContent?.includes(labelText),
      );
      return field?.querySelector('input') ?? null;
    };
    await act(async () => {
      setNativeValue(fieldInput('Name')!, 'Bucket');
      setNativeValue(fieldInput('Endpoint')!, 'https://s3.example.com');
      setNativeValue(fieldInput('Region')!, 'us-east-1');
      setNativeValue(fieldInput('Bucket')!, 'b');
      setNativeValue(fieldInput('Access key ID')!, 'ak');
      setNativeValue(fieldInput('Secret access key')!, 'sk');
    });
    const saveBtn = [...el.querySelectorAll('.wizard button')].find((b) =>
      b.textContent?.includes('Add connection'),
    );
    await act(async () => saveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
    });

    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain('confirm you have exported the recovery kit');

    const confirmBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes("I've saved my recovery kit"),
    ) as HTMLButtonElement;
    await act(async () => confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
    });

    expect(props.confirmRecoveryKit).toHaveBeenCalledTimes(1);
    expect(createConnection).toHaveBeenCalledTimes(2);
    expect(createConnection.mock.calls[1]?.[1]).toBeUndefined(); // retried WITHOUT force
    expect(el.querySelector('[role="dialog"]')).toBeNull(); // dialog closed after success
  });

  it('"Proceed anyway" retries with {force: true} and never calls confirmRecoveryKit', async () => {
    const createConnection = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: 'recovery_kit_not_confirmed', message: 'nope' })
      .mockResolvedValueOnce({ ok: true, value: makeRow() });
    const props = makeProps({ createConnection, loadConnections: vi.fn().mockResolvedValue([]) });
    const el = await mount(props);

    const addBtn = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Add connection'));
    await act(async () => addBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const fieldInput = (labelText: string): HTMLInputElement | null => {
      const field = [...el.querySelectorAll('.field')].find((f) =>
        f.querySelector('.fieldLabel')?.textContent?.includes(labelText),
      );
      return field?.querySelector('input') ?? null;
    };
    await act(async () => {
      setNativeValue(fieldInput('Name')!, 'Bucket');
      setNativeValue(fieldInput('Endpoint')!, 'https://s3.example.com');
      setNativeValue(fieldInput('Region')!, 'us-east-1');
      setNativeValue(fieldInput('Bucket')!, 'b');
      setNativeValue(fieldInput('Access key ID')!, 'ak');
      setNativeValue(fieldInput('Secret access key')!, 'sk');
    });
    const saveBtn = [...el.querySelectorAll('.wizard button')].find((b) =>
      b.textContent?.includes('Add connection'),
    );
    await act(async () => saveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
    });

    const proceedBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Proceed anyway'),
    ) as HTMLButtonElement;
    await act(async () => proceedBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
    });

    expect(props.confirmRecoveryKit).not.toHaveBeenCalled();
    expect(createConnection).toHaveBeenCalledTimes(2);
    expect(createConnection.mock.calls[1]?.[1]).toEqual({ force: true });
    expect(el.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('SettingsStorageScreen — per-vault CAS attach', () => {
  it('shows the local-only state when no s3 tier is attached', async () => {
    const el = await mount(makeProps());
    expect(el.textContent).toContain('stores blobs locally only');
  });

  it('shows which connection this vault is attached to', async () => {
    const props = makeProps({
      loadVaultBlobStore: vi.fn().mockResolvedValue({ kind: 's3', connectionId: 'c1' }),
    });
    const el = await mount(props);
    expect(el.textContent).toContain('My Bucket');
  });

  it('Attach calls attachVaultConnection with the selected connection id', async () => {
    const props = makeProps();
    const el = await mount(props);
    const attachBtn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Attach');
    await act(async () => attachBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
    });
    expect(props.attachVaultConnection).toHaveBeenCalledWith('c1', undefined);
  });

  it('Detach appears once attached and calls detachVaultConnection', async () => {
    const props = makeProps({
      loadVaultBlobStore: vi.fn().mockResolvedValue({ kind: 's3', connectionId: 'c1' }),
    });
    const el = await mount(props);
    const detachBtn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Detach');
    expect(detachBtn).toBeDefined();
    await act(async () => detachBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
    });
    expect(props.detachVaultConnection).toHaveBeenCalledTimes(1);
  });

  it('shows a hint instead of a picker when no connection is CAS-capable', async () => {
    const props = makeProps({
      loadConnections: vi.fn().mockResolvedValue([makeRow({ uses: ['backup'] })]),
    });
    const el = await mount(props);
    expect(el.textContent).toContain('CAS blob replication');
    expect(el.querySelector('select')).toBeNull();
  });
});
