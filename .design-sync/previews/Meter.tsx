import { Meter } from '@centraid/blueprint-kit-ds';

const caption = {
  fontSize: '0.75rem',
  opacity: 0.7,
  marginBottom: '0.35rem',
} as const;

export function StorageUsed() {
  return (
    <div style={{ width: '20rem' }}>
      <div style={caption}>Vault storage — 3.5 of 10 GB</div>
      <Meter ratio={0.35} />
    </div>
  );
}

export function Thresholds() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem', width: '20rem' }}>
      <div>
        <div style={caption}>Documents synced — 35%</div>
        <Meter ratio={0.35} />
      </div>
      <div>
        <div style={caption}>Monthly budget — 70% spent</div>
        <Meter ratio={0.7} tone="warn" />
      </div>
      <div>
        <div style={caption}>Backup window — 92% full</div>
        <Meter ratio={0.92} tone="danger" />
      </div>
    </div>
  );
}
