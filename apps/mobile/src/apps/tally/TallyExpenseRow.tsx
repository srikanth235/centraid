import React, { memo } from "react";
import { View } from "react-native";

import { formatCurrencyMinor } from "@centraid/client/capture";
import type { ReplicaRow } from "@centraid/client/replica/native";

import { Text } from "../../kit/components/NativeText";
import PendingRowStatus from "../../kit/replica/PendingRowStatus";
import type { ThemeColors } from "../../kit/theme";
import { styles } from "./TallyHome.styles";

const asString = (value: unknown): string =>
  value == null ? "" : String(value);

const TallyExpenseRow = memo(
  ({
    row,
    groupLabel,
    currency,
    colors,
    onEditPending,
  }: {
    row: ReplicaRow;
    groupLabel: string;
    currency: string;
    colors: ThemeColors;
    onEditPending?: (row: ReplicaRow) => void;
  }): React.JSX.Element => (
    <View
      style={[
        styles.expense,
        { backgroundColor: colors.bgElev, borderColor: colors.line },
      ]}
    >
      <View style={styles.expenseCopy}>
        <Text style={[styles.personName, { color: colors.text }]}>
          {asString(row.description)}
        </Text>
        <Text style={[styles.meta, { color: colors.textFaint }]}>
          {groupLabel} · {asString(row.spent_on)}
          {row.rate_source ? ` · ${asString(row.rate_source)}` : ""}
        </Text>
        <PendingRowStatus
          row={row}
          {...(onEditPending ? { onEdit: () => onEditPending(row) } : {})}
        />
      </View>
      <Text style={[styles.amount, { color: colors.text }]}>
        {formatCurrencyMinor(Number(row.amount_minor ?? 0), currency)}
      </Text>
    </View>
  )
);

TallyExpenseRow.displayName = "TallyExpenseRow";

export default TallyExpenseRow;
