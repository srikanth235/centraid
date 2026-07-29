// governance: allow-repo-hygiene file-size-limit — this native Tally cover
// keeps fixed-point currency input, offline ledger writes, and recurring
// occurrence controls together so their monetary invariants remain reviewable.
import type { ReplicaRow, ReplicaValue } from "@centraid/client/replica/native";
import { describeRecurrence, expandRecurrence } from "@centraid/time-engine";
import React, { useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import HomeKey from "../../kit/components/HomeKey";
import {
  combineReplicaQueryStates,
  useReplicaQuery,
} from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { family, radii, useTheme } from "../../kit/theme";
import type { NativeWriteResult } from "../../lib/replica/native-session";
import type { TallyScreenProps } from "../../navigation";

const asString = (value: unknown): string =>
  value == null ? "" : String(value);
const cents = (value: string): number => Math.round(Number(value) * 100);
const money = (minor: number, currency: string): string => {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
};
const convert = (original: number, scaled: number): number =>
  Number((BigInt(original) * BigInt(scaled) + 500_000n) / 1_000_000n);
const outputOf = (
  result: NativeWriteResult | undefined
): Record<string, ReplicaValue> | undefined =>
  result && "output" in result && result.output
    ? (result.output as Record<string, ReplicaValue>)
    : undefined;

export default function TallyHome({
  navigation,
}: TallyScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
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
  const parties = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "core.party" }), [])
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
    parties,
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
  const groupName = (id: string): string => {
    const circleId = circleByGroup(id);
    return (
      asString(circles.rows.find((row) => row.circle_id === circleId)?.name) ||
      "Group"
    );
  };
  const activeMemberIds = (() => {
    const circleId = circleByGroup(activeGroupId);
    const ids = members.rows
      .filter((row) => row.circle_id === circleId)
      .map((row) => asString(row.party_id));
    return ids.length > 0 ? ids : ([ownerId].filter(Boolean) as string[]);
  })();
  const expenseRows = expenses.rows
    .filter((row) => !row.deleted_at)
    .toSorted((a, b) =>
      asString(b.spent_on).localeCompare(asString(a.spent_on))
    );

  const write = async (action: string, input: Record<string, ReplicaValue>) => {
    if (!session) return undefined;
    const result = await session.write("tally", { action, input });
    if (result.status === "queued")
      Alert.alert(
        "Saved offline",
        "This Tally change will sync automatically."
      );
    if (result.status === "parked")
      navigation.navigate("Settings", { screen: "Approvals" });
    return result;
  };
  const createGroup = async (): Promise<void> => {
    if (!groupDraft.trim()) return;
    const result = await write("create-group", {
      name: groupDraft.trim(),
      icon: "👥",
      member_ids: [],
    });
    setGroupDraft("");
    const id = asString(outputOf(result)?.group_id);
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
      const templateId = asString(outputOf(result)?.template_id);
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
  const upcomingStarts = (template: ReplicaRow): string[] => {
    if (template.status !== "active") return [];
    const from = new Date();
    const rows = expandRecurrence({
      rrule: asString(template.rrule),
      start: asString(template.anchor_start),
      rangeFrom: from.toISOString(),
      rangeTo: new Date(from.getTime() + 370 * 86_400_000).toISOString(),
      timeZone: asString(template.time_zone) || "UTC",
      maxInstances: 8,
    });
    const exceptionRows = exceptions.rows.filter(
      (row) => row.target_id === template.template_id
    );
    return rows
      .filter(
        (row) =>
          !exceptionRows.some(
            (exception) =>
              exception.action === "skip" &&
              exception.original_start === row.originalStart
          )
      )
      .slice(0, 3)
      .map((row) => row.originalStart);
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
          <Text style={[styles.title, { color: colors.ink }]}>Tally</Text>
          <Text style={[styles.meta, { color: colors.ink3 }]}>
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
            parties.refresh(),
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
                  color: activeGroupId === id ? colors.bg : colors.ink2,
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
          placeholderTextColor={colors.ink3}
          onChangeText={setGroupDraft}
          onSubmitEditing={() => void createGroup()}
          style={[
            styles.groupInput,
            { borderColor: colors.line, color: colors.ink },
          ]}
        />
      </ScrollView>
      <View style={[styles.form, { borderColor: colors.line }]}>
        <TextInput
          value={description}
          placeholder="Expense description"
          placeholderTextColor={colors.ink3}
          onChangeText={setDescription}
          style={[
            styles.input,
            { borderColor: colors.line, color: colors.ink },
          ]}
        />
        <View style={styles.row}>
          <TextInput
            value={amount}
            placeholder="0.00"
            inputMode="decimal"
            placeholderTextColor={colors.ink3}
            onChangeText={setAmount}
            style={[
              styles.input,
              { borderColor: colors.line, color: colors.ink },
            ]}
          />
          <TextInput
            value={originalCurrency}
            maxLength={3}
            accessibilityLabel="Original currency"
            onChangeText={(value) => setOriginalCurrency(value.toUpperCase())}
            style={[
              styles.code,
              { borderColor: colors.line, color: colors.ink },
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
              { borderColor: colors.line, color: colors.ink },
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
                { borderColor: colors.line, color: colors.ink },
              ]}
            />
            <TextInput
              value={rateSource}
              placeholder="Rate source"
              onChangeText={setRateSource}
              style={[
                styles.input,
                { borderColor: colors.line, color: colors.ink },
              ]}
            />
            <TextInput
              value={rateDate}
              placeholder="YYYY-MM-DD"
              onChangeText={setRateDate}
              style={[
                styles.input,
                { borderColor: colors.line, color: colors.ink },
              ]}
            />
          </View>
        )}
        <View style={styles.row}>
          <Text style={{ color: colors.ink2 }}>Repeat monthly</Text>
          <Switch value={recurring} onValueChange={setRecurring} />
          <Pressable
            onPress={() => void saveExpense()}
            style={[styles.save, { backgroundColor: colors.accent }]}
          >
            <Text style={{ color: colors.bg }}>Save expense</Text>
          </Pressable>
        </View>
      </View>
      {templates.rows.length > 0 ? (
        <ScrollView horizontal contentContainerStyle={styles.templates}>
          {templates.rows.map((template) => {
            const upcoming = upcomingStarts(template);
            const next = upcoming[0];
            return (
              <View
                key={asString(template.template_id)}
                style={[
                  styles.template,
                  { backgroundColor: colors.bgElev, borderColor: colors.line },
                ]}
              >
                <Text style={[styles.personName, { color: colors.ink }]}>
                  {asString(template.description)}
                </Text>
                <Text style={[styles.meta, { color: colors.ink3 }]}>
                  {describeRecurrence(asString(template.rrule)) ??
                    asString(template.rrule)}{" "}
                  · {asString(template.original_currency)}
                </Text>
                <Text style={[styles.meta, { color: colors.ink3 }]}>
                  {upcoming.length
                    ? upcoming
                        .map((start) => new Date(start).toLocaleDateString())
                        .join(" · ")
                    : asString(template.status)}
                </Text>
                <View style={styles.row}>
                  <Pressable
                    disabled={!next}
                    onPress={() =>
                      next &&
                      void write("materialize-recurring-expense", {
                        template_id: asString(template.template_id),
                        original_start: next,
                      })
                    }
                  >
                    <Text style={{ color: colors.accent }}>Record</Text>
                  </Pressable>
                  <Pressable
                    disabled={!next}
                    onPress={() =>
                      next &&
                      void write("edit-recurring-expense-occurrence", {
                        template_id: asString(template.template_id),
                        original_start: next,
                        scope: "occurrence",
                        action: "skip",
                      })
                    }
                  >
                    <Text style={{ color: colors.danger }}>Skip</Text>
                  </Pressable>
                  <Pressable
                    disabled={!next}
                    onPress={() =>
                      next && beginEdit(template, next, "occurrence")
                    }
                  >
                    <Text style={{ color: colors.accent }}>Edit this</Text>
                  </Pressable>
                  <Pressable
                    disabled={!next}
                    onPress={() => next && beginEdit(template, next, "future")}
                  >
                    <Text style={{ color: colors.accent }}>Edit future</Text>
                  </Pressable>
                  <Pressable
                    disabled={!next}
                    onPress={() => next && beginEdit(template, next, "series")}
                  >
                    <Text style={{ color: colors.accent }}>Edit series</Text>
                  </Pressable>
                  <Pressable
                    onPress={() =>
                      void write("edit-recurring-expense-occurrence", {
                        template_id: asString(template.template_id),
                        original_start: next ?? new Date().toISOString(),
                        scope: "series",
                        action: "skip",
                      })
                    }
                  >
                    <Text style={{ color: colors.danger }}>End</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </ScrollView>
      ) : null}
      <FlatList
        data={expenseRows}
        keyExtractor={(row) => asString(row.expense_id)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.ink3 }]}>
            No expenses yet. Your offline queue is shown above.
          </Text>
        }
        renderItem={({ item }) => {
          const currency = asString(item.settlement_currency) || baseCurrency;
          return (
            <View
              style={[
                styles.expense,
                { backgroundColor: colors.bgElev, borderColor: colors.line },
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.personName, { color: colors.ink }]}>
                  {asString(item.description)}
                </Text>
                <Text style={[styles.meta, { color: colors.ink3 }]}>
                  {groupName(asString(item.group_id))} ·{" "}
                  {asString(item.spent_on)}
                  {item.rate_source ? ` · ${asString(item.rate_source)}` : ""}
                </Text>
              </View>
              <Text style={[styles.amount, { color: colors.ink }]}>
                {money(Number(item.amount_minor ?? 0), currency)}
              </Text>
            </View>
          );
        }}
      />
      <Modal
        visible={Boolean(editing)}
        transparent
        animationType="fade"
        onRequestClose={() => setEditing(undefined)}
      >
        <View accessibilityViewIsModal style={styles.modalBackdrop}>
          <View style={[styles.modal, { backgroundColor: colors.bgElev }]}>
            <Text style={[styles.personName, { color: colors.ink }]}>
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
                { borderColor: colors.line, color: colors.ink },
              ]}
            />
            <TextInput
              accessibilityLabel="Recurring expense amount"
              value={editAmount}
              inputMode="decimal"
              onChangeText={setEditAmount}
              style={[
                styles.input,
                { borderColor: colors.line, color: colors.ink },
              ]}
            />
            <View style={styles.row}>
              <Pressable onPress={() => setEditing(undefined)}>
                <Text style={{ color: colors.ink2 }}>Cancel</Text>
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  amount: { fontFamily: family.monoMedium, fontSize: 14 },
  chip: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  chips: {
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  code: {
    borderRadius: 9,
    borderWidth: 1,
    fontFamily: family.monoMedium,
    padding: 10,
    width: 58,
  },
  empty: { padding: 28, textAlign: "center" },
  expense: {
    alignItems: "center",
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    padding: 12,
  },
  form: {
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: 8,
    margin: 12,
    padding: 12,
  },
  groupInput: { borderRadius: 9, borderWidth: 1, minWidth: 100, padding: 8 },
  header: { alignItems: "center", flexDirection: "row", gap: 12, padding: 16 },
  input: {
    borderRadius: 9,
    borderWidth: 1,
    flex: 1,
    minWidth: 80,
    padding: 10,
  },
  list: { gap: 8, padding: 12, paddingBottom: 80 },
  meta: { fontFamily: family.sansRegular, fontSize: 12 },
  modal: { borderRadius: radii.lg, gap: 12, margin: 24, padding: 18 },
  modalBackdrop: {
    backgroundColor: "rgba(0,0,0,.4)",
    flex: 1,
    justifyContent: "center",
  },
  personName: { fontFamily: family.sansMedium, fontSize: 14 },
  row: { alignItems: "center", flexDirection: "row", gap: 8 },
  safe: { flex: 1 },
  save: {
    borderRadius: 10,
    marginLeft: "auto",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  template: {
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: 7,
    minWidth: 210,
    padding: 11,
  },
  templates: { gap: 8, paddingHorizontal: 12, paddingVertical: 4 },
  title: { fontFamily: family.displayBold, fontSize: 28 },
});
