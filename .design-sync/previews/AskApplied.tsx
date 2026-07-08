import { AskApplied } from '@centraid/blueprint-kit-ds';

export function Receipt() {
  return <AskApplied title="Filed 3 receipts as Reimbursable" receipt="receipt · txn_9f2a1" />;
}

export function WithUndo() {
  return (
    <AskApplied
      title="Tagged 12 photos “Iceland 2025”"
      receipt="receipt · tag_4c7e"
      onUndo={() => {}}
    />
  );
}

export function Stack() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <AskApplied title="Added Marcus Lee to your contacts" receipt="receipt · party_18b3" />
      <AskApplied
        title="Moved “Lease agreement.pdf” to Legal"
        receipt="receipt · doc_5a90"
        onUndo={() => {}}
      />
    </div>
  );
}
