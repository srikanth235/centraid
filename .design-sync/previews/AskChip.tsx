import { AskChip } from '@centraid/blueprint-kit-ds';

export function Suggestions() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      <AskChip onClick={() => {}}>Summarise this thread</AskChip>
      <AskChip onClick={() => {}}>What&rsquo;s due this week?</AskChip>
      <AskChip onClick={() => {}}>Find the lease PDF</AskChip>
      <AskChip onClick={() => {}}>Who owes me money?</AskChip>
    </div>
  );
}

export function MoneyScope() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      <AskChip onClick={() => {}}>Total spend in March</AskChip>
      <AskChip onClick={() => {}}>Flag unusual charges</AskChip>
      <AskChip onClick={() => {}}>Unreimbursed receipts</AskChip>
    </div>
  );
}

export function Single() {
  return <AskChip onClick={() => {}}>Draft a reply to Priya</AskChip>;
}
