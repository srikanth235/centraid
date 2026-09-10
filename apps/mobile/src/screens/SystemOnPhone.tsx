import React from "react";

import PanelBlock from "../kit/components/PanelBlock";
import { SystemPlace } from "../kit/rooms";
import type { SystemOnPhoneScreenProps } from "../navigation";
import { SYSTEM_ON_PHONE } from "./system-on-phone";

export default function SystemOnPhone({
  navigation,
}: SystemOnPhoneScreenProps): React.JSX.Element {
  return (
    <SystemPlace
      onHome={() => navigation.goBack()}
      title={SYSTEM_ON_PHONE.title}
    >
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
