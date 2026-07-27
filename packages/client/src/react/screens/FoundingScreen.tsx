import { useRef, useState, type JSX } from 'react';
import { Button } from '../ui/index.js';
import type {
  FoundingInitializeResult,
  FoundingRestoreResult,
  FoundingVerifyResult,
} from '../../gateway-client-founding.js';
import styles from './RecoverScreen.module.css';

export interface FoundingScreenBridge {
  initialize: (input: {
    ticket?: string;
    name: string;
    password: string;
    deviceName?: string;
    platform?: string;
  }) => Promise<FoundingInitializeResult>;
  verify: (input: {
    kit: unknown;
    password: string;
    lossConsent: true;
  }) => Promise<FoundingVerifyResult>;
  restore: (input: {
    ticket?: string;
    kit: unknown;
    password: string;
    apiKey: string;
    deviceName?: string;
    platform?: string;
  }) => Promise<FoundingRestoreResult>;
}

export interface FoundingScreenProps extends FoundingScreenBridge {
  mode: 'create' | 'restore';
  onComplete: () => Promise<void> | void;
  onBack: () => void;
}

function downloadKit(kit: unknown): void {
  const blob = new Blob([`${JSON.stringify(kit, null, 2)}\n`], {
    type: 'application/json',
  });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = 'centraid-recovery-kit.json';
  anchor.click();
  // Chromium begins the Blob read after the click handler returns. Revoking
  // synchronously races that read in Electron (404, despite the UI claiming
  // the kit was downloaded), so release it on the next task.
  setTimeout(() => URL.revokeObjectURL(href), 1_000);
}

async function readJsonFile(file: File | undefined): Promise<unknown> {
  if (!file) throw new Error('Select a recovery-kit file.');
  try {
    return JSON.parse(await file.text()) as unknown;
  } catch {
    throw new Error('That file is not a valid recovery kit.');
  }
}

export default function FoundingScreen(props: FoundingScreenProps): JSX.Element {
  const [name, setName] = useState('Personal');
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [created, setCreated] = useState<FoundingInitializeResult>();
  const [selectedKit, setSelectedKit] = useState<unknown>();
  const [selectedName, setSelectedName] = useState('');
  const [lossConsent, setLossConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);

  const chooseFile = async (file: File | undefined): Promise<void> => {
    setError(undefined);
    try {
      setSelectedKit(await readJsonFile(file));
      setSelectedName(file?.name ?? '');
    } catch (reason) {
      setSelectedKit(undefined);
      setSelectedName('');
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const create = async (): Promise<void> => {
    if (!password) {
      setError('Choose a recovery-kit password.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await props.initialize({
        name: name.trim() || 'Personal',
        password,
        ...(ticket.trim() ? { ticket: ticket.trim() } : {}),
        deviceName: 'Centraid desktop',
        platform: 'desktop',
      });
      setCreated(result);
      downloadKit(result.kit);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (): Promise<void> => {
    if (selectedKit === undefined || !lossConsent) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.verify({ kit: selectedKit, password, lossConsent: true });
      await props.onComplete();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (): Promise<void> => {
    if (selectedKit === undefined || !password || !apiKey) {
      setError('Select the kit and enter its password and provider key.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await props.restore({
        kit: selectedKit,
        password,
        apiKey,
        ...(ticket.trim() ? { ticket: ticket.trim() } : {}),
        deviceName: 'Centraid device',
        platform: 'desktop',
      });
      await props.onComplete();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.view} data-mounted="true">
      <div className={styles.stageBg} aria-hidden="true" />
      <div className={styles.stageGlow} aria-hidden="true" />
      <div className={styles.card} data-theme="dark">
        <div className={styles.eyebrow}>CENTRAID · VAULT FOUNDING</div>
        <h1 className={styles.title}>
          {props.mode === 'create' ? 'Create your vault.' : 'Restore your vault.'}
        </h1>
        {props.mode === 'create' ? (
          created ? (
            <>
              <p className={styles.sub}>
                The wrapped kit was downloaded. Re-select that exact file to prove it is readable.
              </p>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                onChange={(event) => void chooseFile(event.currentTarget.files?.[0])}
              />
              <p className={styles.sub}>{selectedName || 'No file selected yet.'}</p>
              <label>
                <input
                  type="checkbox"
                  checked={lossConsent}
                  onChange={(event) => setLossConsent(event.currentTarget.checked)}
                />{' '}
                I understand that losing this file or password makes backed-up vaults unrecoverable.
              </label>
              <Button
                label={busy ? 'Verifying…' : 'Verify and enter'}
                disabled={busy || selectedKit === undefined || !lossConsent}
                onClick={() => void verify()}
              />
            </>
          ) : (
            <>
              <label>
                Vault name
                <input value={name} onChange={(event) => setName(event.currentTarget.value)} />
              </label>
              <label>
                Recovery-kit password
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                />
              </label>
              <label>
                Founding ticket (leave empty on this gateway host)
                <textarea
                  value={ticket}
                  onChange={(event) => setTicket(event.currentTarget.value)}
                />
              </label>
              <Button
                label={busy ? 'Creating…' : 'Create vault and download kit'}
                disabled={busy || !password}
                onClick={() => void create()}
              />
            </>
          )
        ) : (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              onChange={(event) => void chooseFile(event.currentTarget.files?.[0])}
            />
            <p className={styles.sub}>{selectedName || 'Select your wrapped recovery kit.'}</p>
            <label>
              Recovery-kit password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
              />
            </label>
            <label>
              Storage-provider key
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.currentTarget.value)}
              />
            </label>
            <label>
              Founding ticket (leave empty on this gateway host)
              <textarea value={ticket} onChange={(event) => setTicket(event.currentTarget.value)} />
            </label>
            <Button
              label={busy ? 'Restoring…' : 'Restore vault'}
              disabled={busy || selectedKit === undefined || !password || !apiKey}
              onClick={() => void restore()}
            />
          </>
        )}
        {error ? <div role="alert">{error}</div> : null}
        <Button variant="ghost" label="Back" disabled={busy} onClick={props.onBack} />
      </div>
    </div>
  );
}
