import React, { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  View,
} from "react-native";
import type { ListRenderItemInfo } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { ReplicaRow, ReplicaValue } from "@centraid/client/replica/native";

import AudiencePlacementSheet from "../../kit/components/AudiencePlacementSheet";
import HomeKey from "../../kit/components/HomeKey";
import { Text, TextInput } from "../../kit/components/NativeText";
import {
  combineReplicaQueryStates,
  useReplicaQuery,
} from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  nativeWriteOutput,
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { useTheme } from "../../kit/theme";
import type { TallyScreenProps } from "../../navigation";
import TallyExpenseRow from "./TallyExpenseRow";
import { styles } from "./TallyHome.styles";
import TallyRecurringTemplates from "./TallyRecurringTemplates";

const asString = (value: unknown): string =>
  value == null ? "" : String(value);
const cents = (value: string): number => Math.round(Number(value) * 100);
const convert = (original: number, scaled: number): number =>
  Number((BigInt(original) * BigInt(scaled) + 500_000n) / 1_000_000n);
// `expense_id` is the primary key of tally.expense, unique across groups.
const expenseKey = (row: ReplicaRow): string => asString(row.expense_id);

export default function TallyHome({
  navigation,
}: TallyScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const { session, vaultId } = useReplica();
  const vault = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "core.vault" }), [])
  );
  const groups = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "tally.group" }), [])
  );
  const circles = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "social.circle" }), [])
  );
  const members = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "social.circle_member" }), [])
  );
  const expenses = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "tally.expense" }), [])
  );
  const templates = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "tally.recurring_expense" }), [])
  );
  const exceptions = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "schedule.recurrence_exception" }), [])
  );
  const queryState = combineReplicaQueryStates([
    vault,
    groups,
    circles,
    members,
    expenses,
    templates,
    exceptions,
  ]);
  const ownerId = asString(vault.rows[0]?.owner_party_id);
  const baseCurrency = asString(vault.rows[0]?.base_currency) || "USD";
  const [groupId, setGroupId] = useState("");
  const activeGroupId = groupId || asString(groups.rows[0]?.group_id);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [originalCurrency, setOriginalCurrency] = useState(baseCurrency);
  const [settlementCurrency, setSettlementCurrency] = useState(baseCurrency);
  const [rate, setRate] = useState("1");
  const [rateSource, setRateSource] = useState("manual");
  const [rateDate, setRateDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [recurring, setRecurring] = useState(false);
  const [groupDraft, setGroupDraft] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [editing, setEditing] = useState<{
    template: ReplicaRow;
    originalStart: string;
    scope: "occurrence" | "future" | "series";
  }>();
  const [editDescription, setEditDescription] = useState("");
  const [editAmount, setEditAmount] = useState("");

  const circleByGroup = (id: string): string => {
    const group = groups.rows.find((row) => row.group_id === id);
    return asString(group?.circle_id);
  };
  // group_id → circle name. A map, because the previous per-call pair of
  // linear scans ran once for every rendered expense row.
  const groupNameById = useMemo(() => {
    const circleNames = new Map(
      circles.rows.map((row) => [asString(row.circle_id), asString(row.name)])
    );
    return new Map(
      groups.rows.map((row) => [
        asString(row.group_id),
        circleNames.get(asString(row.circle_id)) || "Group",
      ])
    );
  }, [circles.rows, groups.rows]);
  const groupName = (id: string): string => groupNameById.get(id) ?? "Group";
  const activeMemberIds = (() => {
    const circleId = circleByGroup(activeGroupId);
    const ids = members.rows
      .filter((row) => row.circle_id === circleId)
      .map((row) => asString(row.party_id));
    return ids.length > 0 ? ids : ([ownerId].filter(Boolean) as string[]);
  })();
  // Memoised: a fresh filtered+sorted array each render gives FlatList a new
  // data identity and forces a full re-diff of an unchanged ledger.
  const expenseRows = useMemo(
    () =>
      expenses.rows
        .filter((row) => !row.deleted_at)
        .sort((a, b) =>
          asString(b.spent_on).localeCompare(asString(a.spent_on))
        ),
    [expenses.rows]
  );
  const renderExpense = useCallback(
    ({ item }: ListRenderItemInfo<ReplicaRow>): React.JSX.Element => (
      <TallyExpenseRow
        row={item}
        groupLabel={groupNameById.get(asString(item.group_id)) ?? "Group"}
        currency={asString(item.settlement_currency) || baseCurrency}
        colors={colors}
      />
    ),
    [baseCurrency, colors, groupNameById]
  );

  const write = async (action: string, input: Record<string, ReplicaValue>) => {
    if (!session) return undefined;
    try {
      const result = await session.write("tally", { action, input });
      if (
        !surfaceWriteOutcome(result, {
          onParked: () =>
            navigation.navigate("Settings", { screen: "Approvals" }),
          queuedMessage: "This Tally change will sync automatically.",
        })
      )
        return undefined;
      return result;
    } catch (error) {
      surfaceWriteFailure(error, "Tally change failed");
      return undefined;
    }
  };
  const createGroup = async (): Promise<void> => {
    if (!groupDraft.trim()) return;
    const result = await write("create-group", {
      name: groupDraft.trim(),
      icon: "👥",
      member_ids: [],
    });
    setGroupDraft("");
    const id = asString(nativeWriteOutput(result)?.group_id);
    if (id) setGroupId(id);
  };
  const saveExpense = async (): Promise<void> => {
    const originalMinor = cents(amount);
    const original = originalCurrency.trim().toUpperCase();
    const settlement = settlementCurrency.trim().toUpperCase();
    const scaled =
      original === settlement
        ? 1_000_000
        : Math.round(Number(rate) * 1_000_000);
    if (
      !activeGroupId ||
      !ownerId ||
      !description.trim() ||
      originalMinor <= 0 ||
      scaled <= 0 ||
      original.length !== 3 ||
      settlement.length !== 3
    )
      return;
    const settled = convert(originalMinor, scaled);
    const ordered = [...activeMemberIds].sort();
    let assigned = 0;
    const splits = ordered.map((partyId, index) => {
      const share =
        index === ordered.length - 1
          ? settled - assigned
          : Math.floor(settled / ordered.length);
      assigned += share;
      return { party_id: partyId, share_minor: share };
    });
    const currencyFields = {
      original_amount_minor: originalMinor,
      original_currency: original,
      settlement_currency: settlement,
      rate_scaled: scaled,
      rate_scale: 6,
      rate_source: original === settlement ? "identity" : rateSource.trim(),
      rate_date: rateDate,
    };
    if (recurring) {
      const anchor = new Date();
      anchor.setHours(9, 0, 0, 0);
      const result = await write("save-recurring-expense", {
        group_id: activeGroupId,
        description: description.trim(),
        paid_by: ownerId,
        category: "general",
        splits: splits.map((split) => ({
          party_id: split.party_id,
          weight: Math.max(1, split.share_minor),
        })),
        rrule: "FREQ=MONTHLY",
        anchor_start: anchor.toISOString(),
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        ...currencyFields,
      });
      const templateId = asString(nativeWriteOutput(result)?.template_id);
      if (templateId)
        await write("materialize-recurring-expense", {
          template_id: templateId,
          original_start: anchor.toISOString(),
        });
    } else {
      await write("add-expense", {
        group_id: activeGroupId,
        description: description.trim(),
        amount_minor: settled,
        paid_by: ownerId,
        spent_on: new Date().toISOString().slice(0, 10),
        category: "general",
        splits,
        ...currencyFields,
      });
    }
    setDescription("");
    setAmount("");
  };
  const beginEdit = (
    template: ReplicaRow,
    originalStart: string,
    scope: "occurrence" | "future" | "series"
  ): void => {
    setEditDescription(asString(template.description));
    setEditAmount(
      (Number(template.original_amount_minor ?? 0) / 100).toFixed(2)
    );
    setEditing({ template, originalStart, scope });
  };
  const saveRecurringEdit = async (): Promise<void> => {
    if (!editing || cents(editAmount) <= 0 || !editDescription.trim()) return;
    await write("edit-recurring-expense-occurrence", {
      template_id: asString(editing.template.template_id),
      original_start: editing.originalStart,
      scope: editing.scope,
      action: "override",
      override: {
        description: editDescription.trim(),
        original_amount_minor: cents(editAmount),
      },
    });
    setEditing(undefined);
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <HomeKey variant="leave" onPress={() => navigation.goBack()} />
        <View>
          <Text style={[styles.title, { color: colors.text }]}>Tally</Text>
          <Text style={[styles.meta, { color: colors.textFaint }]}>
            Fixed-point multi-currency ledger, available offline
          </Text>
        </View>
      </View>
      <ReplicaStatusBar />
      <ReplicaStateCard
        noun="Tally"
        connection={queryState.connection}
        error={queryState.error}
        unavailableReason={queryState.unavailableReason}
        onRetry={() =>
          void Promise.all([
            vault.refresh(),
            groups.refresh(),
            circles.refresh(),
            members.refresh(),
            expenses.refresh(),
            templates.refresh(),
            exceptions.refresh(),
          ])
        }
      />
      <ScrollView horizontal contentContainerStyle={styles.chips}>
        {groups.rows.map((group) => {
          const id = asString(group.group_id);
          return (
            <Pressable
              key={id}
              onPress={() => setGroupId(id)}
              style={[
                styles.chip,
                {
                  backgroundColor:
                    activeGroupId === id ? colors.accent : colors.bgSunken,
                },
              ]}
            >
              <Text
                style={{
                  color: activeGroupId === id ? colors.bg : colors.textSoft,
                }}
              >
                {groupName(id)}
              </Text>
            </Pressable>
          );
        })}
        <TextInput
          value={groupDraft}
          placeholder="New group"
          placeholderTextColor={colors.textFaint}
          onChangeText={setGroupDraft}
          onSubmitEditing={() => void createGroup()}
          style={[
            styles.groupInput,
            { borderColor: colors.line, color: colors.text },
          ]}
        />
      </ScrollView>
      {activeGroupId ? (
        <Pressable
          accessibilityLabel={`Share ${groupName(activeGroupId)} with household`}
          accessibilityRole="button"
          onPress={() => setShareOpen(true)}
          style={[styles.share, { borderColor: colors.line }]}
        >
          <Text style={{ color: colors.accent }}>
            Share group with household
          </Text>
        </Pressable>
      ) : null}
      <View style={[styles.form, { borderColor: colors.line }]}>
        <TextInput
          value={description}
          placeholder="Expense description"
          placeholderTextColor={colors.textFaint}
          onChangeText={setDescription}
          style={[
            styles.input,
            { borderColor: colors.line, color: colors.text },
          ]}
        />
        <View style={styles.row}>
          <TextInput
            value={amount}
            placeholder="0.00"
            inputMode="decimal"
            placeholderTextColor={colors.textFaint}
            onChangeText={setAmount}
            style={[
              styles.input,
              { borderColor: colors.line, color: colors.text },
            ]}
          />
          <TextInput
            value={originalCurrency}
            maxLength={3}
            accessibilityLabel="Original currency"
            onChangeText={(value) => setOriginalCurrency(value.toUpperCase())}
            style={[
              styles.code,
              { borderColor: colors.line, color: colors.text },
            ]}
          />
          <Text>→</Text>
          <TextInput
            value={settlementCurrency}
            maxLength={3}
            accessibilityLabel="Settlement currency"
            onChangeText={(value) => setSettlementCurrency(value.toUpperCase())}
            style={[
              styles.code,
              { borderColor: colors.line, color: colors.text },
            ]}
          />
        </View>
        {originalCurrency === settlementCurrency ? null : (
          <View style={styles.row}>
            <TextInput
              value={rate}
              placeholder="Rate"
              inputMode="decimal"
              onChangeText={setRate}
              style={[
                styles.input,
                { borderColor: colors.line, color: colors.text },
              ]}
            />
            <TextInput
              value={rateSource}
              placeholder="Rate source"
              onChangeText={setRateSource}
              style={[
                styles.input,
                { borderColor: colors.line, color: colors.text },
              ]}
            />
            <TextInput
              value={rateDate}
              placeholder="YYYY-MM-DD"
              onChangeText={setRateDate}
              style={[
                styles.input,
                { borderColor: colors.line, color: colors.text },
              ]}
            />
          </View>
        )}
        <View style={styles.row}>
          <Text style={{ color: colors.textSoft }}>Repeat monthly</Text>
          <Switch value={recurring} onValueChange={setRecurring} />
          <Pressable
            onPress={() => void saveExpense()}
            style={[styles.save, { backgroundColor: colors.accent }]}
          >
            <Text style={{ color: colors.bg }}>Save expense</Text>
          </Pressable>
        </View>
      </View>
      <TallyRecurringTemplates
        templates={templates.rows}
        exceptions={exceptions.rows}
        colors={colors}
        onWrite={write}
        onBeginEdit={beginEdit}
      />
      <FlatList
        data={expenseRows}
        keyExtractor={expenseKey}
        contentContainerStyle={styles.list}
        // No getItemLayout: styles.expense is padding-based and the expense
        // description wraps, so 62pt holds only for single-line descriptions.
        // The ledger sits under the entry form and the recurring-template
        // carousel — roughly 260pt of a ~800pt screen — so ~4 of the 70pt
        // (62 + 8 gap) rows are visible; 5 covers the first paint.
        initialNumToRender={5}
        maxToRenderPerBatch={5}
        // Ledgers grow without bound, so keep the retained window tight:
        // ±4 viewports ≈ 36 rows.
        windowSize={9}
        removeClippedSubviews
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.textFaint }]}>
            No expenses yet. Your offline queue is shown above.
          </Text>
        }
        renderItem={renderExpense}
      />
      <Modal
        visible={Boolean(editing)}
        transparent
        animationType="fade"
        onRequestClose={() => setEditing(undefined)}
      >
        <View accessibilityViewIsModal style={styles.modalBackdrop}>
          <View style={[styles.modal, { backgroundColor: colors.bgElev }]}>
            <Text style={[styles.personName, { color: colors.text }]}>
              Edit{" "}
              {editing?.scope === "occurrence"
                ? "this occurrence"
                : editing?.scope === "future"
                  ? "this and future"
                  : "the series"}
            </Text>
            <TextInput
              accessibilityLabel="Recurring expense description"
              value={editDescription}
              onChangeText={setEditDescription}
              style={[
                styles.input,
                { borderColor: colors.line, color: colors.text },
              ]}
            />
            <TextInput
              accessibilityLabel="Recurring expense amount"
              value={editAmount}
              inputMode="decimal"
              onChangeText={setEditAmount}
              style={[
                styles.input,
                { borderColor: colors.line, color: colors.text },
              ]}
            />
            <View style={styles.row}>
              <Pressable onPress={() => setEditing(undefined)}>
                <Text style={{ color: colors.textSoft }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void saveRecurringEdit()}
                style={[styles.save, { backgroundColor: colors.accent }]}
              >
                <Text style={{ color: colors.bg }}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <AudiencePlacementSheet
        visible={shareOpen}
        itemType="tally.group"
        itemId={activeGroupId}
        sourceVaultId={asString(
          groups.rows.find((row) => row.group_id === activeGroupId)
            ?.__centraidScopeId ??
            vaultId ??
            ""
        )}
        noun="Tally group"
        onClose={() => setShareOpen(false)}
      />
    </SafeAreaView>
  );
}
