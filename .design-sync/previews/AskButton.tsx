import { AskButton } from '@centraid/blueprint-kit-ds';

export function Default() {
  return <AskButton onClick={() => {}} />;
}

export function CustomLabel() {
  return <AskButton label="Ask your vault" onClick={() => {}} />;
}

export function Pair() {
  return (
    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
      <AskButton onClick={() => {}} />
      <AskButton label="Ask about this receipt" onClick={() => {}} />
    </div>
  );
}
