import React, { useMemo } from "react";

import PanelBlock from "../kit/components/PanelBlock";
import { SystemPlace } from "../kit/rooms";
import type { SignalNotificationScreenProps } from "../navigation";
import { SHELL_TITLES } from "./shell-copy";
import { signalNotificationCopy } from "./signal-notification";

export default function SignalNotification({
  navigation,
  route,
}: SignalNotificationScreenProps): React.JSX.Element {
  const copy = useMemo(
    () => signalNotificationCopy(route.params.cause, route.params.detail),
    [route.params]
  );
  return (
    <SystemPlace onHome={() => navigation.goBack()} title={SHELL_TITLES.alerts}>
      <PanelBlock
        action={{
          label: copy.actionLabel,
          onPress: () =>
            navigation.replace("Settings", {
              params: copy.destinationParams,
              screen: copy.destination,
            }),
        }}
        body={copy.body}
        eyebrow={copy.eyebrow}
        facts={[
          { key: "Cause", value: copy.cause },
          { key: "If ignored", net: true, value: copy.consequence },
        ]}
        title={copy.title}
        tone="net"
      />
    </SystemPlace>
  );
}
