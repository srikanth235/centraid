import { AskPanel, Message, AskApplied } from '@centraid/blueprint-kit-ds';

export function OpenEmpty() {
  return (
    <AskPanel
      scope="Docs"
      suggestions={['Summarise this folder', 'What changed this week?', 'Find duplicates']}
    />
  );
}

export function InConversation() {
  return (
    <AskPanel scope="Money" grantLabel="read + write · consent-gated">
      <Message role="ai">Ask me anything about what this app holds.</Message>
      <Message role="user">File last week’s receipts as reimbursable</Message>
      <AskApplied title="Filed 3 receipts as Reimbursable" receipt="receipt · txn_9f2a1" />
    </AskPanel>
  );
}
