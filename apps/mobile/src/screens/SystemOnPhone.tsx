import React from "react";

import PanelBlock from "../kit/components/PanelBlock";
import { SystemPlace } from "../kit/rooms";
import type { SystemOnPhoneScreenProps } from "../navigation";
import { usePlaceFrame } from "./home/usePlaceFrame";
import { SYSTEM_ON_PHONE } from "./system-on-phone";

export default function SystemOnPhone({
  navigation,
}: SystemOnPhoneScreenProps): React.JSX.Element {
  const frame = usePlaceFrame("gateway");
  return (
    // A place like the other nine (R-NY-1), though never pinnable: the band
    // draws with no tab active, and its Home tab is the way home.
    <SystemPlace {...frame} title={SYSTEM_ON_PHONE.title}>
      <PanelBlock
        action={{
          label: SYSTEM_ON_PHONE.actionLabel,
          onPress: () => navigation.replace("Insights"),
        }}
        body={SYSTEM_ON_PHONE.body}
        eyebrow="On this phone"
        title="System lives with your vault"
      />
    </SystemPlace>
  );
}
