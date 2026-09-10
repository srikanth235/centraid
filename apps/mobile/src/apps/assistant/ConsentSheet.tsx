// THE PROVIDER-CONSENT ASK (#1015, Wave 2 — D4: a CHOICE is a sheet).
//
// It was `Alert.alert` in two files with two spellings of the same question.
// A system alert cannot draw the app's own type, cannot host a status line,
// and has no way to say which of its buttons is the ink one — so the consent
// ask looked like a destructive confirm on one screen and like a neutral
// prompt on the other.
//
// It is not destructive: the ink verb is the ALLOW, and the quiet way out
// declines. Dismissing declines too — silence is not consent, and a turn left
// wedged on `pendingConsent` is the bug the old alert needed `onDismiss` for.

import React from "react";

import { Text } from "../../kit/components/NativeText";
import { SheetRoom } from "../../kit/rooms";
import { t } from "../../kit/theme";

export interface ConsentPending {
  message: string;
  provider: string;
}

export default function ConsentSheet({
  pending,
  onAllow,
  onDecline,
}: {
  pending: ConsentPending | undefined;
  onAllow: () => void;
  onDecline: () => void;
}): React.JSX.Element | null {
  return (
    <SheetRoom
      cancelLabel="Do not share"
      onClose={onDecline}
      primary={{ label: `Allow ${pending?.provider ?? ""}`, onPress: onAllow }}
      title="Share with another provider?"
      visible={pending !== undefined}
    >
      <Text style={t("body")}>{pending?.message ?? ""}</Text>
    </SheetRoom>
  );
}
