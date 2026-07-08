import { Pending } from '@centraid/blueprint-kit-ds';

export function Waiting() {
  return (
    <Pending label="waiting">
      <span>Send email to landlord about the lease renewal</span>
    </Pending>
  );
}

export function Parked() {
  return (
    <Pending label="parked">
      <span>Share “Roof-inspection.jpg” with Dana Whitfield</span>
    </Pending>
  );
}

export function Approving() {
  return (
    <Pending label="needs approval">
      <span>Add “Quarterly review” to your calendar for Apr 12</span>
    </Pending>
  );
}
