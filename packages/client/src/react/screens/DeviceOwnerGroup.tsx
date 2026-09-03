import { useState } from "react";
import type { JSX } from "react";

import RowsBlock from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import type { GroupedDevice } from "./device-groups.js";
import { deviceRowDef, tombstoneRowDef } from "./DeviceRow.js";
import type { DeviceRowActions } from "./DeviceRow.js";

export interface DeviceOwnerGroupProps extends DeviceRowActions {
  label: string;
  devices: readonly GroupedDevice[];
  revoked: readonly GroupedDevice[];
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
    ...revoked.map((device) => tombstoneRowDef(device, now)),
  ];
  return (
    <>
      {/* Head labels the block; no second ariaLabel. */}
      <SectionBlock label={label} meta={String(devices.length)} />
      <RowsBlock rows={rows} />
    </>
  );
}
