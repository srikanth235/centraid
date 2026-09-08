/*
 * THE PER-TABLE REGISTRY the row applier reads (#996, R10).
 *
 * One declaration per table a closure can carry, saying the four things that
 * make an ORIGIN row into an AUDIENCE row: which columns name another row
 * (and which of those are polymorphic), which name a graph the audience never
 * holds and are written NULL, which are re-pointed at the audience's own
 * owner, and what natural key the audience dedupes on.
 *
 * Split out of `apply-outputs.ts` for the repo's file-size rule, along the one
 * seam it has: this file is DATA about the schema and changes when a table
 * does; `apply-outputs.ts` is the machinery and changes when the transport
 * does. Nothing here executes.
 */

export interface RowSpec {
  /** Logical entity name — `share_subscription_lineage.target_type`. */
  readonly entity: string;
  /** Columns naming another row, by the physical table they name. */
  readonly references?: Readonly<Record<string, string>>;
  /** Polymorphic id columns, by the column carrying the target's TYPE. */
  readonly polymorphic?: Readonly<Record<string, string>>;
  /** Columns naming a graph the audience never holds. */
  readonly nulled?: readonly string[];
  /** Columns re-pointed at the audience's own owner party. */
  readonly audienceOwner?: readonly string[];
  /** A reference the audience may legitimately not hold: NULL, never refuse. */
  readonly optionalReferences?: readonly string[];
  /**
   * A NATURAL KEY: the audience already holding a row under these columns
   * means the row is that one. Byte dedupe (`sha256`), an asset's content, an
   * owner's one reading of its bytes — all the same question.
   */
  readonly identity?: readonly string[];
  /**
   * Adopt a row the audience already holds under the ORIGIN's own id. Only for
   * `core_party`, and deliberately: a ledger naming a party the audience
   * already knows twice is a broken ledger, and an accounting party is not a
   * principal, so adopting one grants nothing.
   */
  readonly adoptByOriginId?: boolean;
  /** A name that must not collide within one owner's rows. */
  readonly uniqueWithin?: {
    readonly column: string;
    readonly scope: string;
    readonly suffix: string;
  };
}

/**
 * WRITE ORDER, and its exact reverse for `leave`. A referencing row is written
 * after the row it names and deleted before it, which is the whole reason this
 * is a list and not a set: the audience's foreign keys are real.
 *
 * `locker_item` is absent DELIBERATELY, and its absence is what sends a Locker
 * closure down the snapshot path: its sealed columns must be re-sealed under
 * the AUDIENCE DEK, which needs both vault keys in one process
 * (`project-household.ts`), and no row on a wire can carry that.
 */
export const APPLY_ORDER: readonly string[] = [
  "core_party",
  "core_content_item",
  "media_asset",
  "core_document",
  "core_content_representation",
  "core_concept_scheme",
  "core_concept",
  "core_collection",
  "core_collection_entry",
  "core_tag",
  "social_circle",
  "social_circle_member",
  "tally_group",
  "tally_expense",
  "core_attachment",
  "tally_expense_split",
  "tally_expense_payer",
  "tally_settlement",
  "tally_recurring_expense",
  "tally_recurring_expense_split",
  "schedule_recurrence_exception",
  "tally_expense_line_item",
  "tally_expense_line_allocation",
];

export const SPECS: ReadonlyMap<string, RowSpec> = new Map<string, RowSpec>([
  [
    "core_party",
    {
      entity: "core.party",
      // The avatar names a content item that was never in this closure.
      nulled: ["avatar_content_id"],
      adoptByOriginId: true,
    },
  ],
  [
    "core_content_item",
    {
      entity: "core.content_item",
      nulled: ["creator_party_id", "origin_device_id"],
      // Byte dedupe survives the boundary: the same photograph shared twice is
      // one content item in the audience vault.
      identity: ["sha256"],
    },
  ],
  [
    "media_asset",
    {
      entity: "media.asset",
      references: { content_id: "core_content_item" },
      // `source_asset_id` names an ORIGIN asset (#711).
      nulled: ["place_id", "camera_device_id", "source_asset_id"],
      identity: ["content_id"],
    },
  ],
  [
    "core_document",
    {
      entity: "core.document",
      references: { current_content_id: "core_content_item" },
    },
  ],
  [
    "core_content_representation",
    {
      entity: "core.content_representation",
      references: { content_id: "core_content_item" },
      polymorphic: { owner_id: "owner_type" },
      // An owner has exactly ONE reading of its content, by UNIQUE constraint:
      // two grants over the same photograph must land on the same row.
      identity: ["owner_type", "owner_id"],
    },
  ],
  ["core_concept_scheme", { entity: "core.concept_scheme" }],
  [
    "core_concept",
    {
      entity: "core.concept",
      references: {
        scheme_id: "core_concept_scheme",
        broader_concept_id: "core_concept",
      },
      optionalReferences: ["broader_concept_id"],
    },
  ],
  [
    "core_collection",
    {
      entity: "core.collection",
      references: {
        cover_content_id: "core_content_item",
        parent_collection_id: "core_collection",
      },
      optionalReferences: ["cover_content_id", "parent_collection_id"],
      audienceOwner: ["owner_party_id"],
    },
  ],
  [
    "core_collection_entry",
    {
      entity: "core.collection_entry",
      references: { collection_id: "core_collection" },
      polymorphic: { target_id: "target_type" },
    },
  ],
  [
    "core_tag",
    {
      entity: "core.tag",
      references: { concept_id: "core_concept" },
      polymorphic: { target_id: "target_type" },
      audienceOwner: ["tagged_by_party_id"],
    },
  ],
  [
    "social_circle",
    {
      entity: "social.circle",
      audienceOwner: ["owner_party_id"],
      uniqueWithin: {
        column: "name",
        scope: "owner_party_id",
        suffix: " (shared)",
      },
    },
  ],
  [
    "social_circle_member",
    {
      entity: "social.circle_member",
      references: { circle_id: "social_circle", party_id: "core_party" },
    },
  ],
  [
    "tally_group",
    { entity: "tally.group", references: { circle_id: "social_circle" } },
  ],
  [
    "tally_expense",
    {
      entity: "tally.expense",
      references: { group_id: "tally_group", paid_by: "core_party" },
      // A transaction row belongs to the origin's own accounts.
      nulled: ["txn_id"],
    },
  ],
  [
    "core_attachment",
    {
      entity: "core.attachment",
      references: { content_id: "core_content_item" },
      polymorphic: { target_id: "target_type" },
    },
  ],
  [
    "tally_expense_split",
    {
      entity: "tally.expense_split",
      references: { expense_id: "tally_expense", party_id: "core_party" },
    },
  ],
  [
    "tally_expense_payer",
    {
      entity: "tally.expense_payer",
      references: { expense_id: "tally_expense", party_id: "core_party" },
    },
  ],
  [
    "tally_settlement",
    {
      entity: "tally.settlement",
      references: {
        group_id: "tally_group",
        from_party: "core_party",
        to_party: "core_party",
      },
      nulled: ["txn_id"],
    },
  ],
  [
    "tally_recurring_expense",
    {
      entity: "tally.recurring_expense",
      references: { group_id: "tally_group", paid_by: "core_party" },
    },
  ],
  [
    "tally_recurring_expense_split",
    {
      entity: "tally.recurring_expense_split",
      references: {
        template_id: "tally_recurring_expense",
        party_id: "core_party",
      },
    },
  ],
  [
    "schedule_recurrence_exception",
    {
      entity: "schedule.recurrence_exception",
      polymorphic: { target_id: "target_type" },
    },
  ],
  [
    "tally_expense_line_item",
    {
      entity: "tally.expense_line_item",
      references: {
        expense_id: "tally_expense",
        receipt_id: "core_attachment",
      },
      // A line whose receipt did not cross keeps its typed amounts and loses
      // only the photo pointer.
      optionalReferences: ["receipt_id"],
    },
  ],
  [
    "tally_expense_line_allocation",
    {
      entity: "tally.expense_line_allocation",
      references: {
        line_item_id: "tally_expense_line_item",
        party_id: "core_party",
      },
    },
  ],
]);
