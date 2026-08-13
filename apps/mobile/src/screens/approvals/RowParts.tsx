// The small parts a waiting ROW carries inside its own cell (#765): what was
// actually asked, and the verbs that answer it. They live beside the queue
// rather than in the kit because they are this page's grammar, not a block.

import React from "react";
import { View } from "react-native";

import type { ButtonVariant } from "@centraid/design";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import { useTheme } from "../../kit/theme";
import type { MobileNotice } from "../../lib/gateway";
import { styles } from "./Approvals.styles";
import type { ApprovalsController } from "./useApprovals";

/** What was actually asked, plus the two verbs that answer it. Shown in the
 *  row's own cell so nothing is approved sight-unseen (#647). */
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

/** The two disposal verbs a notice keeps once it is a row. */
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

/** One verb inside a row expansion. Only one expansion is ever open, so the
 *  filled `Approve` there is still the page's single commit — and `Deny` takes
 *  the destructive recipe, which is an outlined `net`, never a fill. */
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
