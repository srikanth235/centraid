import { MentionPopover } from '@centraid/blueprint-kit-ds';

const matches = [
  { kind: 'Person', title: 'Dana Whitfield' },
  { kind: 'Person', title: 'Marcus Lindqvist' },
  { kind: 'Document', title: 'Lease agreement.pdf' },
  { kind: 'Event', title: 'Quarterly review' },
  { kind: 'File', title: 'Roof-inspection.jpg' },
  { kind: 'Note', title: 'Renewal terms to revisit' },
];

export function Picking() {
  return <MentionPopover items={matches} selectedIndex={2} style={{ position: 'static' }} />;
}

export function TopMatch() {
  return (
    <MentionPopover
      items={matches.slice(0, 4)}
      selectedIndex={0}
      note="Picking links only the picked item — receipted."
      style={{ position: 'static' }}
    />
  );
}

export function NoMatches() {
  return <MentionPopover items={[]} style={{ position: 'static' }} />;
}
