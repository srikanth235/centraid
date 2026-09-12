//! **The recipe catalogue: six templates, six result commands** (#1020,
//! D-1020-AU4).
//!
//! `docs/recognition-automations.md` *Content and result flow* is the table
//! this module is. It is a table rather than six `match` arms for the reason
//! the trigger registry is: a recipe that entered the catalogue without
//! declaring its content read, its result command, its provenance tier and its
//! model pin would be a recipe nobody could audit.
//!
//! Two rows worth stating out loud:
//!
//! - **`place-names` recognises nothing about the member's bytes.** Its input
//!   is a coordinate a photograph already carried, its knowledge is a table of
//!   settlements bundled with the automation, and its output is a settlement
//!   name written into `core_place.address_json` — **never** into
//!   `core_place.name`, because a member-entered name is authoritative and
//!   derived data may not overwrite it (#816). It carries no weights, so the
//!   weights step is not a precondition for it at all.
//! - **Transcription is the deliberate exception** to "use the derivative":
//!   a shortened recording loses content, not resolution, so `transcript`
//!   reads bounded ORIGINAL bytes where every image recipe reads a preview.
//!
//! ## What the port does NOT carry, and why
//!
//! The `faces` row's result is "face-region and embedding commands" — and
//! `media.*` is the Photos lane's schema (census §Cross-lane). This module
//! therefore NAMES the commands and invokes them through `ctx.invoke`; it does
//! not define them. `core.set_extracted_text` is the Docs lane's, in the
//! `core` schema, and is named the same way.

use crate::manifest::{EnrichDomain, EnrichLane};

use super::{Provenance, provenance};

/// What a recipe reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentRead {
    /// The thumbnail/preview derivative. Every image recipe.
    Preview,
    /// Vault text, or a versioned text/transcript derivative.
    Text,
    /// **Bounded ORIGINAL bytes.** The deliberate exception.
    BoundedOriginal,
    /// A place row's own stored coordinate. **No media bytes at all.**
    Coordinate,
}

impl ContentRead {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Preview => "preview",
            Self::Text => "text",
            Self::BoundedOriginal => "bounded-original",
            Self::Coordinate => "coordinate",
        }
    }
}

/// One row of the catalogue.
#[derive(Debug, Clone, Copy)]
pub struct Recipe {
    /// The template id, which is also its capability and its reservation.
    pub id: &'static str,
    pub domain: EnrichDomain,
    /// The declared lane. Every bundled recipe is deterministic work, so every
    /// one declares `device` — and the gate still reads provenance, so a
    /// system recipe with no readable policy runs sealed rather than refusing.
    pub lane: EnrichLane,
    pub content: ContentRead,
    /// The ONE command this recipe's result is persisted through.
    pub result_command: &'static str,
    /// A second command, for `faces`: a region and its embedding are two rows.
    pub also_command: Option<&'static str>,
    /// The `models.lock.json` capability whose weights this recipe needs, or
    /// `None` when it carries none.
    pub weights_capability: Option<&'static str>,
    /// `<name>@<version>`, as stamped into `enrich_derivation.model`.
    pub model_id: Option<&'static str>,
}

impl Recipe {
    /// The tier, read from the constants — never from this row.
    #[must_use]
    pub fn provenance(&self) -> Provenance {
        provenance(self.id)
    }

    /// The `<id>/<id>` ref a fire names.
    #[must_use]
    pub fn automation_ref(&self) -> String {
        format!("{}/{}", self.id, self.id)
    }
}

/// The catalogue. **Six templates**, which is the count
/// `docs/recognition-automations.md` states.
pub const CATALOGUE: [Recipe; 6] = [
    Recipe {
        id: "embed-image",
        domain: EnrichDomain::Photos,
        lane: EnrichLane::Device,
        content: ContentRead::Preview,
        result_command: "enrich.upsert_embedding",
        also_command: None,
        weights_capability: Some("embed-image"),
        model_id: Some("clip-vit-b-32@1"),
    },
    Recipe {
        id: "embed-text",
        domain: EnrichDomain::Docs,
        lane: EnrichLane::Device,
        content: ContentRead::Text,
        result_command: "enrich.upsert_embedding",
        also_command: None,
        weights_capability: Some("embed-text"),
        model_id: Some("clip-vit-b-32@1"),
    },
    Recipe {
        id: "photo-ocr",
        domain: EnrichDomain::Photos,
        lane: EnrichLane::Device,
        content: ContentRead::Preview,
        // Docs' schema, named and invoked — never defined here.
        result_command: "core.set_extracted_text",
        also_command: None,
        weights_capability: Some("ocr"),
        model_id: Some("pp-ocrv5@1"),
    },
    Recipe {
        id: "faces",
        domain: EnrichDomain::Photos,
        lane: EnrichLane::Device,
        content: ContentRead::Preview,
        // Photos' schema. A region and its embedding are two rows.
        result_command: "media.upsert_face_region",
        also_command: Some("enrich.upsert_embedding"),
        weights_capability: Some("faces"),
        model_id: Some("yunet-arcface@1"),
    },
    Recipe {
        id: "transcript",
        domain: EnrichDomain::Docs,
        lane: EnrichLane::Device,
        // THE DELIBERATE EXCEPTION.
        content: ContentRead::BoundedOriginal,
        result_command: "core.set_extracted_text",
        also_command: None,
        weights_capability: Some("transcript"),
        model_id: Some("whisper-tiny.en-q8@1"),
    },
    Recipe {
        id: "place-names",
        domain: EnrichDomain::Photos,
        lane: EnrichLane::Device,
        // NO MEDIA BYTES AT ALL.
        content: ContentRead::Coordinate,
        result_command: "media.set_place_gazetteer",
        also_command: None,
        // A vendored GeoNames table, not a model: `setup` is not a
        // precondition for it and the lookup is arithmetic.
        weights_capability: None,
        model_id: None,
    },
];

/// `doc-text-extractor` is a SYSTEM recipe with no template row of its own:
/// it is the PDF text layer, which is extraction rather than inference. It is
/// named here so the count difference between
/// [`super::SYSTEM_AUTOMATION_IDS`] + [`super::BUNDLED_OPTIONAL_AUTOMATION_IDS`]
/// (7) and [`CATALOGUE`] (6) is a documented fact rather than a missing row.
pub const EXTRACTION_ONLY_IDS: [&str; 1] = ["doc-text-extractor"];

/// One recipe by id.
#[must_use]
pub fn recipe(id: &str) -> Option<&'static Recipe> {
    CATALOGUE.iter().find(|entry| entry.id == id)
}

/// Every distinct result command the catalogue writes through, sorted.
#[must_use]
pub fn result_commands() -> Vec<&'static str> {
    let mut commands: Vec<&'static str> = CATALOGUE
        .iter()
        .flat_map(|recipe| std::iter::once(recipe.result_command).chain(recipe.also_command))
        .collect();
    commands.sort_unstable();
    commands.dedup();
    commands
}

/// Every `models.lock.json` capability the catalogue needs, sorted.
#[must_use]
pub fn weights_capabilities() -> Vec<&'static str> {
    let mut capabilities: Vec<&'static str> = CATALOGUE
        .iter()
        .filter_map(|recipe| recipe.weights_capability)
        .collect();
    capabilities.sort_unstable();
    capabilities.dedup();
    capabilities
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalogue_is_six_templates_and_every_id_is_reserved() {
        assert_eq!(CATALOGUE.len(), 6);
        let reserved = super::super::reserved_ids();
        for recipe in CATALOGUE {
            assert!(
                reserved.contains(&recipe.id),
                "{} must be reserved against code-store apps",
                recipe.id
            );
        }
        for id in EXTRACTION_ONLY_IDS {
            assert!(reserved.contains(&id), "{id}");
            assert!(recipe(id).is_none(), "{id} runs no model");
        }
        // The seven reserved ids are the six templates plus the extraction-only
        // one, so the count difference is accounted for rather than missing.
        assert_eq!(CATALOGUE.len() + EXTRACTION_ONLY_IDS.len(), reserved.len());
    }

    #[test]
    fn every_template_names_its_content_read_its_command_and_its_model() {
        for recipe in CATALOGUE {
            assert!(recipe.result_command.contains('.'), "{}", recipe.id);
            // A recipe with weights has a model id, and one without has
            // neither: the two go together, which is what makes the stamp
            // meaningful.
            assert_eq!(
                recipe.weights_capability.is_some(),
                recipe.model_id.is_some(),
                "{}",
                recipe.id
            );
            if let Some(model) = recipe.model_id {
                assert!(model.contains('@'), "{model} is not <name>@<version>");
            }
        }
    }

    #[test]
    fn the_provenance_tiers_are_read_from_the_constants_and_not_from_the_row() {
        assert_eq!(
            recipe("faces").expect("a row").provenance(),
            Provenance::System
        );
        assert_eq!(
            recipe("photo-ocr").expect("a row").provenance(),
            Provenance::System
        );
        for id in ["embed-image", "embed-text", "transcript", "place-names"] {
            assert_eq!(
                recipe(id).expect("a row").provenance(),
                Provenance::BundledOptional,
                "{id}"
            );
        }
        assert_eq!(
            recipe("faces").expect("a row").automation_ref(),
            "faces/faces"
        );
    }

    /// The three result-command schemas, and who owns each.
    #[test]
    fn the_result_commands_are_four_across_three_schemas() {
        let commands = result_commands();
        assert_eq!(
            commands,
            [
                "core.set_extracted_text",
                "enrich.upsert_embedding",
                "media.set_place_gazetteer",
                "media.upsert_face_region",
            ]
        );
        // `enrich.*` is this lane's; `core.*` is Docs'; `media.*` is Photos'.
        let owned: Vec<&str> = commands
            .iter()
            .filter(|command| command.starts_with("enrich."))
            .copied()
            .collect();
        assert_eq!(owned, ["enrich.upsert_embedding"]);
    }

    /// `place-names` reads no media bytes at all, and carries no weights.
    #[test]
    fn place_names_reads_a_coordinate_and_carries_no_weights() {
        let places = recipe("place-names").expect("a row");
        assert_eq!(places.content, ContentRead::Coordinate);
        assert_eq!(places.weights_capability, None);
        assert_eq!(places.model_id, None);
        assert_eq!(places.result_command, "media.set_place_gazetteer");
    }

    /// TRANSCRIPTION IS THE EXCEPTION: bounded originals, not a preview.
    #[test]
    fn transcription_is_the_one_recipe_that_reads_an_original() {
        let originals: Vec<&str> = CATALOGUE
            .iter()
            .filter(|recipe| recipe.content == ContentRead::BoundedOriginal)
            .map(|recipe| recipe.id)
            .collect();
        assert_eq!(
            originals,
            ["transcript"],
            "a shortened recording loses content, not resolution"
        );
    }

    #[test]
    fn the_weights_capabilities_are_the_ones_the_lock_pins() {
        assert_eq!(
            weights_capabilities(),
            ["embed-image", "embed-text", "faces", "ocr", "transcript"]
        );
    }

    /// Every bundled recipe declares the `device` lane, and the gate still
    /// reads provenance — a system recipe with no readable policy runs sealed
    /// rather than refusing.
    #[test]
    fn every_bundled_recipe_declares_the_deterministic_lane() {
        for recipe in CATALOGUE {
            assert_eq!(recipe.lane, EnrichLane::Device, "{}", recipe.id);
        }
    }
}
