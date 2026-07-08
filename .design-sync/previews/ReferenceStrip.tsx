import { ReferenceStrip } from '@centraid/blueprint-kit-ds';

const live = [
  {
    link_id: '1',
    card: { type: 'core.party', title: 'Dana Whitfield', subtitle: 'Accountant', status: 'live' },
    selector: {},
  },
  { link_id: '2', card: { type: 'core.document', title: 'Lease agreement.pdf', status: 'live' } },
  { link_id: '3', card: { type: 'core.event', title: 'Quarterly review', subtitle: 'Apr 12', status: 'live' } },
];

export function Linked() {
  return <ReferenceStrip refs={live} inlineIds={['1']} />;
}

export function Removable() {
  return <ReferenceStrip refs={live} onRemove={() => {}} />;
}

export function BrokenLinks() {
  return (
    <ReferenceStrip
      refs={[
        { link_id: '4', card: { type: 'core.document', title: 'Old planning notes', status: 'trashed' } },
        { link_id: '5', card: { type: 'core.party', title: '', status: 'missing' } },
        { link_id: '6', card: { type: 'core.asset', title: 'Shared budget', status: 'denied' } },
      ]}
    />
  );
}

export function Empty() {
  return <ReferenceStrip refs={[]} emptyText="No references yet — @-mention an entity to link it." />;
}
