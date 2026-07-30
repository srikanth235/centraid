// Follow-up rung after TIME_ORGANIZE_DDL (issue #630): identity merge is only
// `core.merge_party`. The soft people_merge edge table was never a durable
// ontology surface after #638 folded people.merge_people away. This rung drops
// the residual table without editing the already-applied organize band.

export const DROP_PEOPLE_MERGE_DDL = `
DROP INDEX IF EXISTS people_merge_revision_idx;
DROP INDEX IF EXISTS people_merge_target_idx;
DROP INDEX IF EXISTS people_merge_source_active_idx;
DROP TABLE IF EXISTS people_merge;
`;
