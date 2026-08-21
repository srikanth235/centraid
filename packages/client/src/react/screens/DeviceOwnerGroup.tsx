import { useState } from "react";
import type { JSX } from "react";

import RowsBlock from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import type { GroupedDevice } from "./device-groups.js";
import { deviceRowDef, tombstoneRowDef } from "./DeviceRow.js";
import type { DeviceRowActions } from "./DeviceRow.js";

/*
 * One labelled block of devices — "Yours", or everybody else (#726, #765).
 *
 * The v9 page splits the roster by WHOSE the hardware is, not by person: your
 * own devices are the section you act on, and everyone else's are one block
 * beneath it whose rows name their person in the sub line. A vault has exactly
 * one owner and a device caller sees only its own owner's roster row
 * (topology hiding), so on most gateways the second block never renders at
 * all — which is why it is omitted rather than drawn empty.
 *
 * Removing a PERSON is a host-custody act on this machine (`owners-routes.ts`)
 * — never reachable from a device-token client — so the only removal verb
 * offered here is "Revoke device", inside a row's own detail.
 */

export interface DeviceOwnerGroupProps extends DeviceRowActions {
  /** The section label ("Yours"). */
  label: string;
  /** Live bindings, already merged one row per piece of hardware. */
  devices: readonly GroupedDevice[];
  /** Tombstoned bindings, kept so past attribution still resolves. */
  revoked: readonly GroupedDevice[];
  /** Name each row's person — set for everyone but yourself. */
  showOwner?: boolean;
  now: number;
}

export default function DeviceOwnerGroup({
  label,
  devices,
  revoked,
  showOwner,
  now,
  onRevoke,
  onRename,
  onUpdateCompute,
}: DeviceOwnerGroupProps): JSX.Element {
  // At most one row is expanded: two open editors in one block is two places
  // to look for the verb you just pressed.
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = [
    ...devices.map((device) =>
      deviceRowDef({
        device,
        now,
        onToggle: () =>
          setOpenId((current) =>
            current === device.endpointId ? null : device.endpointId
          ),
        open: openId === device.endpointId,
        ...(showOwner ? { showOwner } : {}),
        ...(onRevoke ? { onRevoke } : {}),
        ...(onRename ? { onRename } : {}),
        ...(onUpdateCompute ? { onUpdateCompute } : {}),
      })
    ),
    // Tombstones count for nothing and act on nothing; they sit at the foot of
    // the block in disabled ink so the audit trail stays readable.
    ...revoked.map((device) => tombstoneRowDef(device, now)),
  ];
  return (
    <>
      {/* The section head names the block, so the rows carry no second
          `ariaLabel` — one heading and one group label would be announced as
          two stops for the same list. */}
      <SectionBlock label={label} meta={String(devices.length)} />
      <RowsBlock rows={rows} />
    </>
  );
}
