import React from "react";
import { View } from "react-native";

import type { ButtonVariant } from "@centraid/design";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import { useTheme } from "../../kit/theme";
import type { MobileNotice } from "../../lib/gateway";
import { styles } from "./Approvals.styles";
import type { ApprovalsController } from "./useApprovals";

export function Detail(props: {
  text: string;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View>
      {props.text ? (
        <Text
          selectable
          style={[styles.detailText, { color: colors.textSoft }]}
        >
          {props.text}
        </Text>
      ) : null}
      <View style={styles.detailActions}>
        {props.busy ? null : (
          <>
            <ActionButton
              label="Approve"
              onPress={props.onApprove}
              variant="primary"
            />
            <ActionButton
              label="Deny"
              onPress={props.onDeny}
              variant="destructive"
            />
          </>
        )}
      </View>
    </View>
  );
}

export function NoticeVerbs(props: {
  notice: MobileNotice;
  busy: boolean;
  page: ApprovalsController;
}): React.JSX.Element | null {
  const { busy, notice, page } = props;
  if (busy || notice.archivedAt !== null) return null;
  return (
    <View style={styles.detailActions}>
      {notice.readAt === null ? (
        <ActionButton
          label="Mark read"
          onPress={() => page.readNotice(notice.noticeId)}
        />
      ) : null}
      <ActionButton
        label="Archive"
        onPress={() => page.archiveNotice(notice.noticeId)}
      />
    </View>
  );
}

function ActionButton(props: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
}): React.JSX.Element {
  return (
    <Button
      label={props.label}
      onPress={props.onPress}
      variant={props.variant ?? "secondary"}
    />
  );
}
