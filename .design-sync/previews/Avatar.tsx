import { Avatar } from '@centraid/blueprint-kit-ds';

export function People() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
      <Avatar name="Dana Whitfield" />
      <Avatar name="Priya Nair" />
      <Avatar name="Marcus Lee" />
      <Avatar name="Sofia Alvarez" />
      <Avatar name="Ken Watanabe" />
    </div>
  );
}

export function LargeProfile() {
  return <Avatar name="Priya Nair" size="4rem" />;
}

export function RoundedTeam() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
      <Avatar name="Riverside Market" shape="rounded" size="3rem" />
      <Avatar name="Household Vault" shape="rounded" size="3rem" />
      <Avatar name="Tax Circle" shape="rounded" size="3rem" />
    </div>
  );
}
