//! A NOTE'S VERSION CHAIN IS ITS OWN OCCURRENCES (#996 R20(a); #1020 D-1020-N2).
//!
//! Walk `knowledge_note.current_revision_id` through `parent_revision_id`; each
//! occurrence names the content that became current at that moment. The chain is
//! **append-only**: a restore appends a new head naming the body it brings back
//! and nothing between is rewritten, which is why `current` is a POSITION (index
//! 0) and never a stored flag.
//!
//! It used to be a `revises` content→content `core_link` chain — a second
//! history mechanism beside the one table [#916] ruled the only one — keyed by
//! CONTENT, so a note that returned to a body it already held collapsed two
//! versions into one node and two notes with identical bytes shared one history
//! (`version-chain.ts:1`-`:14`, drift ONT-22).
//!
//! ## The one place this port does NOT reproduce v0
//!
//! v0's walk `break`s on a revision it has already seen and returns what it
//! has; so does `revisionChainOf` on the command side
//! (`packages/vault/src/commands/revisions.ts:120`-`:122`), and so does the
//! `MAX_CHAIN_STEPS` cap. **A truncated list is indistinguishable from a short
//! history**: the screen draws four versions and the note has forty, or a
//! cycle, and nothing says which. `parent_revision_id` has no constraint that
//! forbids a cycle — the DDL's only guard is the FK — so the malformed chain is
//! representable today and reader-caught tomorrow.
//!
//! [`note_version_chain`] returns a typed [`VersionChainError`] for both, and
//! the accompanying storage guard is proposed as
//! `contracts/migrations/002_revisions.sql` (the receipt names every reader
//! that moves with it). A refusal is the honest answer: a member who cannot see
//! their history knows it, and a member shown four of forty versions does not.

/// A well-formed chain terminates on a null parent; this caps a malformed one.
/// v0's number, in three places (`version-chain.ts:24`, `history.ts:18`,
/// `revisions.ts:120`).
pub const MAX_CHAIN_STEPS: usize = 500;

/// What a chain walk refuses, and why each is a refusal rather than a short
/// list.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VersionChainError {
    /// The walk came back to a revision it had already visited. The chain is
    /// malformed; the `restore_note_version` precondition's `UNION` terminates
    /// on it, and a reader that quietly stopped would draw a partial history as
    /// a whole one.
    #[error(
        "note {note_id}: revision {revision_id} is its own ancestor — a version chain is append-only and this one is a cycle (#1020, D-1020-N2)"
    )]
    Cycle {
        note_id: String,
        revision_id: String,
    },

    /// The chain is longer than the cap. The cap NAMES the size it reached, for
    /// the same reason a fan-out does (D-1020-D3-12).
    #[error(
        "note {note_id}: the version chain passes {steps} occurrences without terminating; a well-formed chain ends on a null parent"
    )]
    TooLong { note_id: String, steps: usize },
}

/// One occurrence, as the walk reads it off a revision row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Occurrence {
    pub revision_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub content_id: String,
    pub parent_revision_id: Option<String>,
    pub recorded_at: String,
}

/// The chain a note's occurrences make: head first, then each older body.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChainWalk {
    /// Content ids, head first. A content id may appear TWICE — A→B→A is three
    /// occurrences and reads as three.
    pub content_ids: Vec<String>,
    /// The instant each content became current, by its FIRST (newest)
    /// occurrence. A content id that appears twice is dated by the occurrence
    /// the member is looking at.
    pub asserted_at: Vec<(String, String)>,
}

impl ChainWalk {
    /// The instant a content id became current, if the walk saw it.
    #[must_use]
    pub fn asserted(&self, content_id: &str) -> Option<&str> {
        self.asserted_at
            .iter()
            .find(|(id, _)| id == content_id)
            .map(|(_, at)| at.as_str())
    }
}

/// Walk one note's occurrences.
///
/// `head_content_id` is the note's current body, which is the answer when it has
/// no occurrence yet: **a note minted before the wrapper carried a pointer still
/// has one version — the body it is currently made of. Honest absence, not a
/// hole** (`version-chain.ts:64`-`:66`).
///
/// Foreign occurrences are filtered here rather than trusted from the read: a
/// door may answer wider than it was asked, and a revision belongs to ONE
/// object (#996 R20(a)).
///
/// # Errors
///
/// [`VersionChainError::Cycle`] and [`VersionChainError::TooLong`].
pub fn note_version_chain(
    note_id: &str,
    head_content_id: &str,
    current_revision_id: Option<&str>,
    occurrences: &[Occurrence],
) -> Result<ChainWalk, VersionChainError> {
    let mut walk = ChainWalk::default();
    if head_content_id.is_empty() {
        return Ok(walk);
    }
    let mine: Vec<&Occurrence> = occurrences
        .iter()
        .filter(|occurrence| occurrence.entity_type == crate::queries::NOTE_TARGET_TYPE)
        .filter(|occurrence| occurrence.entity_id == note_id)
        .collect();

    let mut seen: Vec<&str> = Vec::new();
    let mut at = current_revision_id;
    let mut steps = 0usize;
    while let Some(revision_id) = at {
        if steps >= MAX_CHAIN_STEPS {
            return Err(VersionChainError::TooLong {
                note_id: note_id.to_owned(),
                steps,
            });
        }
        if seen.contains(&revision_id) {
            return Err(VersionChainError::Cycle {
                note_id: note_id.to_owned(),
                revision_id: revision_id.to_owned(),
            });
        }
        seen.push(revision_id);
        // A POINTER INTO A REVISION THIS READ DID NOT CARRY is the end of what
        // can be said, not a malformation: the window that fetched the
        // occurrences is `MAX_CHAIN_STEPS` rows and a note with more history
        // than that simply has more. It is the same stop v0 makes.
        let Some(occurrence) = mine
            .iter()
            .find(|occurrence| occurrence.revision_id == revision_id)
        else {
            break;
        };
        if occurrence.content_id.is_empty() {
            break;
        }
        walk.content_ids.push(occurrence.content_id.clone());
        if !walk
            .asserted_at
            .iter()
            .any(|(id, _)| *id == occurrence.content_id)
        {
            walk.asserted_at.push((
                occurrence.content_id.clone(),
                occurrence.recorded_at.clone(),
            ));
        }
        at = occurrence
            .parent_revision_id
            .as_deref()
            .filter(|parent| !parent.is_empty());
        steps += 1;
    }
    if walk.content_ids.is_empty() {
        walk.content_ids.push(head_content_id.to_owned());
    }
    Ok(walk)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn occurrence(id: &str, content: &str, parent: Option<&str>, at: &str) -> Occurrence {
        Occurrence {
            revision_id: id.to_owned(),
            entity_type: crate::queries::NOTE_TARGET_TYPE.to_owned(),
            entity_id: "note-1".to_owned(),
            content_id: content.to_owned(),
            parent_revision_id: parent.map(str::to_owned),
            recorded_at: at.to_owned(),
        }
    }

    #[test]
    fn a_note_with_no_occurrence_still_has_the_body_it_is_made_of() {
        let walk = note_version_chain("note-1", "content-1", None, &[]).expect("a walk");
        assert_eq!(walk.content_ids, ["content-1"]);
        assert!(walk.asserted_at.is_empty());
    }

    #[test]
    fn the_chain_is_head_first_and_a_repeated_body_is_two_versions() {
        let rows = [
            occurrence("rev-3", "content-1", Some("rev-2"), "2099-06-03"),
            occurrence("rev-2", "content-2", Some("rev-1"), "2099-06-02"),
            occurrence("rev-1", "content-1", None, "2099-06-01"),
        ];
        let walk = note_version_chain("note-1", "content-1", Some("rev-3"), &rows).expect("a walk");
        assert_eq!(walk.content_ids, ["content-1", "content-2", "content-1"]);
        // The date shown is the occurrence the member is looking at — the
        // newest, because the walk is head first.
        assert_eq!(walk.asserted("content-1"), Some("2099-06-03"));
        assert_eq!(walk.asserted("content-2"), Some("2099-06-02"));
    }

    /// A REVISION BELONGS TO ONE OBJECT. A read that answered wider than it was
    /// asked cannot put another note's version in this history.
    #[test]
    fn a_foreign_occurrence_is_filtered_rather_than_trusted() {
        let mut foreign = occurrence("rev-1", "content-9", None, "2099-06-01");
        foreign.entity_id = "note-2".to_owned();
        let mut other_kind = occurrence("rev-2", "content-8", None, "2099-06-01");
        other_kind.entity_type = "core.document".to_owned();
        let walk = note_version_chain("note-1", "content-1", Some("rev-1"), &[foreign, other_kind])
            .expect("a walk");
        assert_eq!(walk.content_ids, ["content-1"]);
    }

    /// **THE CYCLE REFUSAL** (D-1020-N2). v0 `break`s here and hands back a
    /// partial list that reads as a whole history.
    #[test]
    fn a_cycle_is_a_refusal_and_never_a_truncated_list() {
        let rows = [
            occurrence("rev-2", "content-2", Some("rev-1"), "2099-06-02"),
            occurrence("rev-1", "content-1", Some("rev-2"), "2099-06-01"),
        ];
        let refused = note_version_chain("note-1", "content-2", Some("rev-2"), &rows);
        assert_eq!(
            refused,
            Err(VersionChainError::Cycle {
                note_id: "note-1".to_owned(),
                revision_id: "rev-2".to_owned(),
            })
        );
        // And the sentence names the note and the revision, because a member
        // who cannot see their history is owed which one is broken.
        let message = refused.unwrap_err().to_string();
        assert!(message.contains("note-1") && message.contains("rev-2"));
    }

    /// A self-parent is the shortest cycle there is, and the DDL permits it.
    #[test]
    fn a_revision_that_is_its_own_parent_is_a_cycle() {
        let rows = [occurrence(
            "rev-1",
            "content-1",
            Some("rev-1"),
            "2099-06-01",
        )];
        assert!(matches!(
            note_version_chain("note-1", "content-1", Some("rev-1"), &rows),
            Err(VersionChainError::Cycle { .. })
        ));
    }

    #[test]
    fn a_chain_longer_than_the_cap_is_a_refusal_that_names_the_size_it_reached() {
        let rows: Vec<Occurrence> = (0..=MAX_CHAIN_STEPS)
            .map(|index| {
                occurrence(
                    &format!("rev-{index}"),
                    &format!("content-{index}"),
                    Some(&format!("rev-{}", index + 1)),
                    "2099-06-01",
                )
            })
            .collect();
        let refused = note_version_chain("note-1", "content-0", Some("rev-0"), &rows);
        assert_eq!(
            refused,
            Err(VersionChainError::TooLong {
                note_id: "note-1".to_owned(),
                steps: MAX_CHAIN_STEPS,
            })
        );
    }

    /// A pointer into a revision this read did not carry is the END of what can
    /// be said — not a malformation, and not a refusal.
    #[test]
    fn a_parent_the_window_did_not_reach_ends_the_walk_quietly() {
        let rows = [occurrence(
            "rev-2",
            "content-2",
            Some("rev-1"),
            "2099-06-02",
        )];
        let walk = note_version_chain("note-1", "content-2", Some("rev-2"), &rows).expect("a walk");
        assert_eq!(walk.content_ids, ["content-2"]);
    }
}
