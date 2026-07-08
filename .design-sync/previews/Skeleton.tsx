import { Skeleton } from '@centraid/blueprint-kit-ds';

export function LoadingList() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', width: '18rem' }}>
      <Skeleton rows={3} />
    </div>
  );
}

export function NoteCard() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '18rem' }}>
      <Skeleton variant="title" width="60%" />
      <Skeleton rows={2} variant="line" />
      <Skeleton variant="line" width="80%" />
    </div>
  );
}

export function ContactRow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '18rem' }}>
      <Skeleton variant="circle" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1 }}>
        <Skeleton variant="row" width="70%" />
        <Skeleton variant="row" width="45%" />
      </div>
    </div>
  );
}
