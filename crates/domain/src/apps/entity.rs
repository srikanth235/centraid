//! Reads over `entity` that no one app owns: a kind's starred rows, what a home holds, and how
//! many of each kind it holds (the number a delete confirm names, N11).

use crate::read::{DEFAULT_PAGE, ParamTy, Read, ReadDecl, Shape, desc, param, read};

use super::{Held, Item};

/// Starred rows of one kind, newest star first: `entity_starred`.
pub const STARRED: Read<Item> = read(STARRED_DECL, Item::of);

pub const STARRED_DECL: ReadDecl = ReadDecl {
    name: "entity.starred",
    shape: Shape::PagedList,
    sql: "SELECT id, title, starred_at AS at FROM entity \
          WHERE kind = :kind AND starred_at IS NOT NULL AND deleted_at IS NULL \
            AND (starred_at, id) < (:a, :b) \
          ORDER BY starred_at DESC, id DESC LIMIT :n",
    params: &[param("kind", ParamTy::Text)],
    reads: &["entity"],
    across: &[],
    bound: DEFAULT_PAGE,
    cursor: &[desc("at", "a"), desc("id", "b")],
};

/// What a home holds, of one kind, most recently changed first: `entity_by_home`. A read of a
/// home without its kind sorts in a temp B-tree, so the kind is named.
pub const IN_HOME: Read<Item> = read(
    ReadDecl {
        name: "entity.in_home",
        shape: Shape::PagedList,
        sql: "SELECT id, title, updated_at AS at FROM entity \
              WHERE parent_id = :home AND kind = :kind AND deleted_at IS NULL \
                AND (updated_at, id) < (:a, :b) \
              ORDER BY updated_at DESC, id DESC LIMIT :n",
        params: &[param("home", ParamTy::Id), param("kind", ParamTy::Text)],
        reads: &["entity"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    Item::of,
);

/// How many live rows of each kind a home holds. A delete confirm names the number: "and its 12
/// notes".
pub const HELD_COUNTS: Read<Held> = read(
    ReadDecl {
        name: "entity.held_counts",
        shape: Shape::Aggregate,
        sql: "SELECT kind, count(*) AS count FROM entity \
              WHERE parent_id = :home AND deleted_at IS NULL GROUP BY kind",
        params: &[param("home", ParamTy::Id)],
        reads: &["entity"],
        across: &[],
        bound: 25,
        cursor: &[],
    },
    Held::of,
);

pub const HELD: Read<String> = read(
    ReadDecl {
        name: "entity.held",
        shape: Shape::ByKey,
        sql: "SELECT id FROM entity WHERE id = :id",
        params: &[param("id", ParamTy::Id)],
        reads: &["entity"],
        across: &[],
        bound: 1,
        cursor: &[],
    },
    |row| row.get("id"),
);

pub const READS: &[ReadDecl] = &[STARRED.decl, IN_HOME.decl, HELD_COUNTS.decl, HELD.decl];
