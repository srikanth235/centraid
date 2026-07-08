import { AskPropose } from '@centraid/blueprint-kit-ds';

export function Simple() {
  return (
    <AskPropose
      title="Add “Renew passport” to your tasks"
      detail="Due Aug 14 · flagged high priority from your Docs scan"
      onApprove={() => {}}
      onDiscard={() => {}}
    />
  );
}

export function WithDiff() {
  return (
    <AskPropose
      title="Update the invoice to Northwind Studio"
      detail="Marking it as paid changes its status in Money."
      diff={['Draft', 'Sent']}
      onApprove={() => {}}
      onEdit={() => {}}
      onDiscard={() => {}}
    />
  );
}

export function DateChange() {
  return (
    <AskPropose
      title="Reschedule dinner with Priya"
      detail="She replied that Thursday works better."
      diff={['Wed, Jul 9', 'Thu, Jul 10']}
      onApprove={() => {}}
      onEdit={() => {}}
      onDiscard={() => {}}
    />
  );
}
