import { MentionChip } from '@centraid/blueprint-kit-ds';

export function InSentence() {
  return (
    <p style={{ margin: 0, lineHeight: 1.7 }}>
      Met with <MentionChip card={{ type: 'core.party', title: 'Dana Whitfield', status: 'live' }} /> about
      the <MentionChip card={{ type: 'core.document', title: 'Lease agreement.pdf', status: 'live' }} /> before the{' '}
      <MentionChip card={{ type: 'core.event', title: 'Quarterly review', status: 'live' }} /> yesterday.
    </p>
  );
}

export function KindVariety() {
  return (
    <p style={{ margin: 0, lineHeight: 1.7 }}>
      Filed <MentionChip card={{ type: 'core.asset', title: 'Roof-inspection.jpg', status: 'live' }} /> next to
      the <MentionChip card={{ type: 'knowledge.note', title: 'Renewal terms to revisit', status: 'live' }} /> for{' '}
      <MentionChip card={{ type: 'core.party', title: 'Marcus Lindqvist', status: 'live' }} />.
    </p>
  );
}

export function Removed() {
  return (
    <p style={{ margin: 0, lineHeight: 1.7 }}>
      The old <MentionChip card={{ type: 'core.document', title: 'Draft agreement', status: 'trashed' }} /> and the{' '}
      <MentionChip card={{ type: 'core.party', title: 'Priya Nair', status: 'missing' }} /> reference no longer resolve.
    </p>
  );
}
