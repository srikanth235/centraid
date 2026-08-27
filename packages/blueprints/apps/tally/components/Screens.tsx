// The three screens the app lives on: Balances, Activity and Groups.
//
// BALANCES IS ONE FIGURE, THEN THE PEOPLE, THEN THE GROUPS, and every one of
// those figures arrives derived from `queries/dashboard.ts`. This file adds up
// nothing: it chooses a word for a sign, an absolute value for an amount, and
// a tone for a leaf.
//
// ACTIVITY INTERLEAVES two kinds of fact under three day headings, and states
// where its window ends. A settlement where neither party is the owner changes
// a balance and nothing else, which its own row says out loud.
//
// GROUPS DRAWS TWO REAL ACTS. Leave and Archive both write; the confirms they
// open state the consequence in the handoff's own words and then commit.
// ARCHIVED GROUPS ARE THEIR OWN SECTION — they leave the lists and keep
// everything, so filtering them into silence would be the one thing archiving
// is not — and each carries the verb that brings it back.
//
// REMIND IS ON A BALANCE ROW THAT HAS GONE QUIET. It always parks: this app
// has no delivery path, so the row offers to PREPARE a reminder and the
// confirm says so before the press.
import type { ReactNode } from "react";

import { identityInitials } from "@centraid/design";

import { dayBuckets, windowOf } from "../activity-model.ts";
import { feedFacts } from "../entry-facts.ts";
import {
  allSettled,
  figureTone,
  groupSubLabel,
  metaSentence,
  money,
  netFigure,
  personSubLabel,
} from "../format.ts";
import type { ActivityData, DashboardData } from "../types.ts";
import {
  ARCHIVED_META,
  EMPTY,
  SECTIONS,
  SECTION_META,
  SETTLEMENT_NOT_YOURS,
  VERBS,
  balancesHeroSub,
  expenseCount,
  memberCount,
  HERO_LEVEL,
  HERO_OWE,
  HERO_OWED,
  HERO_SETTLED_SUB,
} from "../view-copy.ts";
import { Hero, Rows, Section, WindowEnd } from "./Blocks.tsx";
import { EntryRow } from "./EntryRow.tsx";
import { LedgerRow } from "./LedgerRow.tsx";
import { AllSettled } from "./States.tsx";

import styles from "./Ledger.module.css";

export interface BalancesProps {
  data: DashboardData;
  narrow: boolean;
  onOpenFriend: (partyId: string) => void;
  onOpenGroup: (groupId: string) => void;
  onAddFriend: () => void;
  onNewGroup: () => void;
  onSettle: () => void;
  onSpending: () => void;
  /** Prepare a reminder about one friend's balance. Always parks. */
  onRemind: (friend: {
    party_id: string;
    name: string;
    net_minor: number;
  }) => void;
}

export function Balances(props: BalancesProps): ReactNode {
  const { data } = props;
  // The hero's figure is the two totals the dashboard derived, differenced —
  // not a third sum over the rows below it. `owed - owe` is the same
  // subtraction the sub-line states in words, and it is the only arithmetic on
  // this screen.
  const net = data.owed_total_minor - data.owe_total_minor;
  const level =
    allSettled(data.friends.map((friend) => friend.net_minor)) &&
    allSettled(data.groups.map((group) => group.owner_net_minor));
  const tone = figureTone(net);

  return (
    <div className={styles.list}>
      <Hero
        figure={netFigure(net, data.currency, "Settled")}
        tone={tone}
        label={
          tone === "settled"
            ? HERO_LEVEL
            : tone === "net"
              ? HERO_OWE
              : HERO_OWED
        }
        sub={
          level
            ? HERO_SETTLED_SUB
            : balancesHeroSub(
                money(data.owed_total_minor, data.currency),
                money(data.owe_total_minor, data.currency),
                data.expense_count ?? 0,
                data.settlement_count ?? 0
              )
        }
        acts={[
          { label: VERBS.settleUp, run: props.onSettle },
          { label: SECTIONS.byCategory, run: props.onSpending },
        ]}
      />

      {level ? <AllSettled /> : null}

      <Section
        label={SECTIONS.people}
        meta={SECTION_META.people}
        count={data.friends.length}
        empty={EMPTY.people}
        narrow={props.narrow}
        verb={{ label: VERBS.addFriend, run: props.onAddFriend }}
      >
        <Rows>
          {data.friends.map((friend) => (
            <LedgerRow
              key={friend.party_id}
              chip={{
                partyId: friend.party_id,
                initials: friend.initials || identityInitials(friend.name),
              }}
              title={friend.name}
              figure={{
                text: netFigure(friend.net_minor, data.currency),
                tone: figureTone(friend.net_minor),
                sub: personSubLabel(friend.net_minor),
              }}
              acts={
                // ONLY WHERE THERE IS SOMETHING TO REMIND ABOUT. A level
                // balance has nothing owed, and a row that owes YOU money is
                // the one a reminder is for.
                friend.net_minor > 0
                  ? [
                      {
                        label: VERBS.remind,
                        run: () => props.onRemind(friend),
                      },
                    ]
                  : []
              }
              narrow={props.narrow}
              onOpen={() => props.onOpenFriend(friend.party_id)}
            />
          ))}
        </Rows>
      </Section>

      <Section
        label={SECTIONS.groups}
        meta={SECTION_META.groups}
        count={data.groups.length}
        empty={EMPTY.groups}
        narrow={props.narrow}
        verb={{ label: VERBS.newGroup, run: props.onNewGroup }}
      >
        <Rows>
          {data.groups.map((group) => (
            <LedgerRow
              key={group.group_id}
              title={group.name}
              meta={memberCount(group.member_count)}
              figure={{
                text: netFigure(group.owner_net_minor, data.currency),
                tone: figureTone(group.owner_net_minor),
                sub: groupSubLabel(group.owner_net_minor),
              }}
              narrow={props.narrow}
              onOpen={() => props.onOpenGroup(group.group_id)}
            />
          ))}
        </Rows>
      </Section>
    </div>
  );
}

export interface ActivityProps {
  data: ActivityData;
  now: string;
  window: number;
  narrow: boolean;
  onShowMore: () => void;
}

export function Activity(props: ActivityProps): ReactNode {
  const view = windowOf(props.data.activity, props.window);
  const buckets = dayBuckets(view.rows, props.now);
  const currency = props.data.currency;

  return (
    <div className={styles.list}>
      {buckets.map((bucket) => (
        <Section
          key={bucket.key}
          label={bucket.label}
          meta={expenseCount(bucket.rows.length)}
          count={bucket.rows.length}
        >
          <Rows>
            {bucket.rows.map((row, index) => {
              const key = `${bucket.key}-${index}`;
              if (row.kind === "settlement") {
                const mine =
                  row.from_party === props.data.me ||
                  row.to_party === props.data.me;
                return (
                  <LedgerRow
                    key={key}
                    title={settlementTitle(row.from_name, row.to_name)}
                    meta={metaSentence([
                      row.date,
                      money(row.amount_minor, currency),
                      row.group_name,
                      mine ? "" : SETTLEMENT_NOT_YOURS,
                    ])}
                    figure={{
                      text: money(row.amount_minor, currency),
                      tone: "settled",
                      sub: "settled",
                    }}
                    narrow={props.narrow}
                  />
                );
              }
              return (
                <EntryRow
                  key={key}
                  facts={feedFacts(row)}
                  currency={currency}
                  me={props.data.me}
                  {...(row.group_name ? { groupName: row.group_name } : {})}
                  narrow={props.narrow}
                />
              );
            })}
          </Rows>
        </Section>
      ))}

      <WindowEnd
        shown={view.shown}
        total={view.total}
        more={view.more}
        label={VERBS.showMore}
        onShowMore={props.onShowMore}
      />
    </div>
  );
}

function settlementTitle(from?: string, to?: string): string {
  return `${from ?? ""} paid ${to ?? ""}`.trim();
}

export interface GroupsProps {
  data: DashboardData;
  narrow: boolean;
  onOpenGroup: (groupId: string) => void;
  onNewGroup: () => void;
  onLeave: (groupId: string) => void;
  /** `archived` is what the group IS now, so the confirm can ask the right
   *  question and the write can send the other boolean. */
  onArchive: (groupId: string, archived: boolean) => void;
}

export function Groups(props: GroupsProps): ReactNode {
  const { data } = props;
  return (
    <div className={styles.list}>
      <Section
        label={SECTIONS.groups}
        meta={SECTION_META.groups}
        count={data.groups.length}
        empty={EMPTY.groups}
        narrow={props.narrow}
        verb={{ label: VERBS.newGroup, run: props.onNewGroup }}
      >
        <Rows>
          {data.groups.map((group) => (
            <LedgerRow
              key={group.group_id}
              title={group.name}
              meta={memberCount(group.member_count)}
              figure={{
                text: netFigure(group.owner_net_minor, data.currency),
                tone: figureTone(group.owner_net_minor),
                sub: groupSubLabel(group.owner_net_minor),
              }}
              acts={[
                {
                  label: VERBS.archive,
                  run: () => props.onArchive(group.group_id, false),
                },
                {
                  label: VERBS.leave,
                  run: () => props.onLeave(group.group_id),
                },
              ]}
              narrow={props.narrow}
              onOpen={() => props.onOpenGroup(group.group_id)}
            />
          ))}
        </Rows>
      </Section>

      {/* ARCHIVING IS NOT DELETING. The section exists whenever the dashboard
          answered with one, so a member can always see what left the lists —
          and every row carries the verb that brings it back. */}
      {props.data.archived_groups ? (
        <Section
          label={SECTIONS.archived}
          meta={SECTION_META.archived}
          count={props.data.archived_groups.length}
          empty={EMPTY.archived}
          narrow={props.narrow}
        >
          <Rows>
            {props.data.archived_groups.map((group) => (
              <LedgerRow
                key={group.group_id}
                title={group.name}
                meta={ARCHIVED_META}
                figure={{
                  text: netFigure(group.owner_net_minor, data.currency),
                  tone: figureTone(group.owner_net_minor),
                  sub: groupSubLabel(group.owner_net_minor),
                }}
                acts={[
                  {
                    label: VERBS.unarchive,
                    run: () => props.onArchive(group.group_id, true),
                  },
                ]}
                narrow={props.narrow}
                onOpen={() => props.onOpenGroup(group.group_id)}
              />
            ))}
          </Rows>
        </Section>
      ) : null}
    </div>
  );
}
