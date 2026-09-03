import type { ReactNode } from "react";

import { appearsOnLedger } from "../activity-model.ts";
import {
  SIMPLIFICATION,
  SIMPLIFY_NONE,
  SIMPLIFY_OFF,
  SIMPLIFY_STOP,
  simplifyChanged,
  transferLine,
} from "../compose-copy.ts";
import { entryFacts } from "../entry-facts.ts";
import {
  figureTone,
  metaSentence,
  money,
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
  SECTIONS,
  SECTION_META,
  VERBS,
  expenseCount,
  friendHeroOwe,
  friendHeroOwed,
  memberCount,
  partSubLabel,
  sharedExpenseCount,
} from "../view-copy.ts";
import { Hero, Note, Rows, Section } from "./Blocks.tsx";
import { EntryRow } from "./EntryRow.tsx";
import { LedgerRow } from "./LedgerRow.tsx";

import styles from "./Ledger.module.css";

function nameOfMember(data: GroupData, partyId: string): string {
  return (
    data.members.find((member) => member.party_id === partyId)?.name ?? partyId
  );
}

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
  onDelete: () => void;
  onLeave: () => void;
  onArchive: () => void;
  onSimplify: (simplify: boolean) => void;
}

export function GroupLedger(props: GroupLedgerProps): ReactNode {
  const { data } = props;
  if (!data.group) return null;
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
          {
            label: data.group.simplify_opt_in ? SIMPLIFY_STOP : VERBS.simplify,
            run: () => props.onSimplify(!data.group?.simplify_opt_in),
          },
          { label: VERBS.leave, run: props.onLeave },
          {
            label: data.group.archived_at ? VERBS.unarchive : VERBS.archive,
            run: props.onArchive,
          },
          {
            label: VERBS.deleteGroup,
            run: props.onDelete,
            destructive: true,
          },
        ]}
      />

      {/* THE PROPOSAL LIVES BESIDE THE LEDGER IT REWIRES. Off is the default
          and stays a stated fact; on shows what it changed, in this group's
          own figures, and nothing about it is written. */}
      {data.simplification ? (
        <Section
          label={SECTIONS.simplification}
          meta={SECTION_META.simplification}
          count={data.simplification.transfers.length}
          empty={data.simplification.opted_in ? SIMPLIFY_NONE : SIMPLIFY_OFF}
          narrow={props.narrow}
        >
          <Rows>
            {data.simplification.transfers.map((transfer) => (
              <LedgerRow
                key={`${transfer.from}-${transfer.to}-${transfer.amount_minor}`}
                title={transferLine(
                  nameOfMember(data, transfer.from),
                  nameOfMember(data, transfer.to),
                  money(transfer.amount_minor, data.currency)
                )}
                narrow={props.narrow}
              />
            ))}
          </Rows>
          <Note>
            {data.simplification.opted_in
              ? metaSentence([
                  SIMPLIFICATION,
                  simplifyChanged(
                    data.simplification.debts_before,
                    data.simplification.payments_after
                  ),
                ])
              : SIMPLIFICATION}
          </Note>
        </Section>
      ) : null}

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

  const parts = data.friend.parts ?? [];

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
              key={part.group_id ?? "no-group"}
              title={part.group_name}
              figure={{
                text: netFigure(part.net_minor, data.currency),
                tone: figureTone(part.net_minor),
                sub: partSubLabel(part.net_minor),
              }}
              narrow={props.narrow}
              {...(part.group_id
                ? { onOpen: () => props.onOpenGroup(part.group_id as string) }
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
              {...(entry.group_id && nameOf.get(entry.group_id)
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
