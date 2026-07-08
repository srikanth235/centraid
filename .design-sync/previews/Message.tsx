import { Message } from '@centraid/blueprint-kit-ds';

export function Assistant() {
  return (
    <Message role="ai">
      I found 3 receipts from last week totalling $214.80. Want me to file them under “Reimbursable”?
    </Message>
  );
}

export function User() {
  return <Message role="user">Show me everything tagged “taxes” from this year</Message>;
}

export function Conversation() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <Message role="user">What did I spend on groceries in March?</Message>
      <Message role="ai">
        You spent $412.36 across 9 trips — about 18% less than February. The biggest was $88.20 at Riverside Market on the 14th.
      </Message>
    </div>
  );
}
