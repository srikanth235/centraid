// The two screens that cut a net: a GROUP's ledger and a FRIEND's.
//
// GROUP LEDGER. Members with the nets the group engine derived, departed
// members kept on the ledger with the balance they left, and the group's
// expenses newest-first. The removal guard lives on the member row: a member
// who appears anywhere on this ledger cannot be removed, because removing them
// would make the arithmetic unreadable — they are marked departed instead.
//
// FRIEND. Every part of one net, openable. The parts Tally can show today are
// the GROUPS the two of you share and the expenses with no group, each opening
// the ledger where its own figure is derived, plus the standing obligation
// People holds — which Tally reads and never writes.
//
// WHY THE PARTS CARRY NO FIGURE OF THEIR OWN. `queries/friend.ts` returns the
// net whole. Splitting it per group here would mean a second balance engine in
// the interface, computing from the shared expenses it happens to have loaded
// — which is exactly the thing this app does not do. The parts are therefore
// named, counted and openable, and the note under them says the per-part
// figure is an engineering ask rather than quietly showing a wrong one.
import type { ReactNode } from "react";

import { appearsOnLedger } from "../activity-model.ts";
import {
  figureTone,
  metaSentence,
  netFigure,
  personSubLabel,
} from "../format.ts";
import type {
  FriendData,
  GroupData,
  GroupSummary,
  LedgerEntry,
} from "../types.ts";
import {
  CO_CONTRIBUTES,
  DEPARTED_META,
  EMPTY,
  FRIEND_HERO_LEVEL,
  FRIEND_HERO_SUB,
  FRIEND_PARTS_NOTE,
  GROUP_HERO_LEVEL,
  GROUP_HERO_OWE,
  GROUP_HERO_OWED,
  GROUP_HERO_SUB,
  IOU_META,
  IOU_TITLE,
  ON_THE_LEDGER,
  OUTSIDE_ANY_GROUP,
  SECTIONS,
  SECTION_META,
  VERBS,
  expenseCount,
  friendHeroOwe,
  friendHeroOwed,
  memberCount,
  sharedExpenseCount,
} from "../view-copy.ts";
import { Hero, Note, Rows, Section } from "./Blocks.tsx";
import { EntryRow, entryFacts } from "./EntryRow.tsx";
import { LedgerRow } from "./LedgerRow.tsx";

import styles from "./Ledger.module.css";

export interface GroupLedgerProps {
  data: GroupData;
  narrow: boolean;
  onAddExpense: () => void;
  onExport: () => void;
  onAddSomeone: () => void;
  onRemoveMember: (partyId: string) => void;
  onOpenExpense: (entry: LedgerEntry) => void;
  onSettle: () => void;
  onRename: () => void;
  /** The vault refuses a group that still holds expenses; the confirm puts the
   *  refusal in front of the question where this ledger already knows it. */
  onDelete: () => void;
}

export function GroupLedger(props: GroupLedgerProps): ReactNode {
  const { data } = props;
  if (!data.group) return null;
  // The owner's own net in this group, read off the members list the query
  // derived — not a second fold over the ledger below it.
  const mine = data.members.find((member) => member.is_me)?.net_minor ?? 0;
  const tone = figureTone(mine);

  return (
    <div className={styles.list}>
      <Hero
        figure={netFigure(mine, data.currency, "Settled")}
        tone={tone}
        label={
          tone === "settled"
            ? GROUP_HERO_LEVEL
            : tone === "net"
              ? GROUP_HERO_OWE
              : GROUP_HERO_OWED
        }
        sub={GROUP_HERO_SUB}
        acts={[
          { label: VERBS.settleUp, run: props.onSettle },
          // DESTRUCTIVE IS OUTLINED, never filled, and it sits beside the
          // group's own figure because that is where the group IS.
          {
            label: VERBS.deleteGroup,
            run: props.onDelete,
            destructive: true,
          },
        ]}
      />

      <Section
        label={SECTIONS.members}
        meta={metaSentence([
          memberCount(data.members.length),
          SECTION_META.members,
        ])}
        count={data.members.length}
        narrow={props.narrow}
        verb={{ label: VERBS.addSomeone, run: props.onAddSomeone }}
        verb2={{ label: VERBS.rename, run: props.onRename }}
      >
        <Rows>
          {data.members.map((member) => {
            const held = appearsOnLedger(data.ledger, member.party_id);
            return (
              <LedgerRow
                key={member.party_id}
                chip={{
                  partyId: member.party_id,
                  initials: member.initials,
                }}
                title={member.name}
                meta={
                  member.departed
                    ? DEPARTED_META
                    : held
                      ? ON_THE_LEDGER
                      : CO_CONTRIBUTES
                }
                figure={{
                  text: netFigure(member.net_minor, data.currency),
                  tone: figureTone(member.net_minor),
                  sub: personSubLabel(member.net_minor),
                }}
                acts={
                  member.departed || member.is_me
                    ? []
                    : [
                        {
                          label: VERBS.remove,
                          run: () => props.onRemoveMember(member.party_id),
                        },
                      ]
                }
                narrow={props.narrow}
              />
            );
          })}
        </Rows>
      </Section>

      <Section
        label={SECTIONS.ledger}
        meta={metaSentence([
          expenseCount(data.ledger.length),
          SECTION_META.ledger,
        ])}
        count={data.ledger.length}
        empty={EMPTY.ledger}
        narrow={props.narrow}
        verb={{ label: VERBS.addExpense, run: props.onAddExpense }}
        verb2={{ label: VERBS.export, run: props.onExport }}
      >
        <Rows>
          {data.ledger.map((entry) => (
            <EntryRow
              key={entry.expense_id}
              facts={entryFacts(entry)}
              currency={data.currency}
              me={data.me}
              narrow={props.narrow}
              onOpen={() => props.onOpenExpense(entry)}
            />
          ))}
        </Rows>
      </Section>
    </div>
  );
}

export interface FriendScreenProps {
  data: FriendData;
  /** Every group this vault knows, so a shared one can be named and opened. */
  groups: readonly GroupSummary[];
  narrow: boolean;
  onOpenGroup: (groupId: string) => void;
  onOpenExpense: (entry: LedgerEntry) => void;
  onSettle: () => void;
}

export function FriendScreen(props: FriendScreenProps): ReactNode {
  const { data } = props;
  if (!data.friend) return null;
  const net = data.friend.net_minor;
  const tone = figureTone(net);
  const nameOf = new Map(
    props.groups.map((group) => [group.group_id, group.name])
  );

  // The parts, counted off the shared ledger the query returned. A COUNT is
  // not a balance: it says how much of the net is behind each part without
  // claiming to know how much of it, which the query does not report.
  const perGroup = new Map<string, number>();
  for (const entry of data.ledger) {
    const key = entry.group_id || "";
    perGroup.set(key, (perGroup.get(key) ?? 0) + 1);
  }
  const parts = [...perGroup.entries()].map(([groupId, count]) => ({
    groupId,
    count,
    name: groupId
      ? (nameOf.get(groupId) ?? SECTIONS.groups)
      : OUTSIDE_ANY_GROUP,
  }));

  return (
    <div className={styles.list}>
      <Hero
        figure={netFigure(net, data.currency, "Settled")}
        tone={tone}
        label={
          tone === "settled"
            ? FRIEND_HERO_LEVEL
            : tone === "net"
              ? friendHeroOwe(data.friend.name)
              : friendHeroOwed(data.friend.name)
        }
        sub={FRIEND_HERO_SUB}
        acts={[{ label: VERBS.settleUp, run: props.onSettle }]}
      />

      <Section
        label={SECTIONS.parts}
        meta={SECTION_META.parts}
        count={parts.length + 1}
        narrow={props.narrow}
      >
        <Rows>
          {parts.map((part) => (
            <LedgerRow
              key={part.groupId || "no-group"}
              title={part.name}
              meta={sharedExpenseCount(part.count)}
              narrow={props.narrow}
              {...(part.groupId
                ? { onOpen: () => props.onOpenGroup(part.groupId) }
                : {})}
            />
          ))}
          {/* READ-ONLY. The obligation lives in People; Tally reads it into
              the net above and never writes one. */}
          <LedgerRow title={IOU_TITLE} meta={IOU_META} narrow={props.narrow} />
        </Rows>
        <Note>{FRIEND_PARTS_NOTE}</Note>
      </Section>

      <Section
        label={SECTIONS.together}
        meta={sharedExpenseCount(data.ledger.length)}
        count={data.ledger.length}
        empty={EMPTY.together}
        narrow={props.narrow}
      >
        <Rows>
          {data.ledger.map((entry) => (
            <EntryRow
              key={entry.expense_id}
              facts={entryFacts(entry)}
              currency={data.currency}
              me={data.me}
              {...(nameOf.get(entry.group_id)
                ? { groupName: nameOf.get(entry.group_id) }
                : {})}
              narrow={props.narrow}
              onOpen={() => props.onOpenExpense(entry)}
            />
          ))}
        </Rows>
      </Section>
    </div>
  );
}
