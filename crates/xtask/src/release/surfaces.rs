use std::collections::BTreeSet;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseSurface {
    pub id: &'static str,
    pub title: &'static str,
    pub cadence: &'static str,
    pub default_on_product_tag: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_pattern: Option<&'static str>,
    pub secret_groups: &'static [&'static str],
    pub notes: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatrixSurface {
    #[serde(flatten)]
    pub surface: ReleaseSurface,
    pub in_default_ship: bool,
    pub in_this_ship: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceMatrix {
    pub product_version_rule: &'static str,
    pub protocol_rule: &'static str,
    pub build_number_rule: &'static str,
    pub default_ship: Vec<String>,
    pub ship_this_cycle: Vec<String>,
    pub surfaces: Vec<MatrixSurface>,
}

pub const RELEASE_SURFACES: &[ReleaseSurface] = &[
    ReleaseSurface {
        id: "gateway-image",
        title: "Gateway container (GHCR)",
        cadence: "tag",
        default_on_product_tag: true,
        workflow: Some("lane-release-gateway-image.yml"),
        tag_pattern: Some("v*"),
        secret_groups: &["gateway-image"],
        notes: "latest tag only for non-beta (D5).",
    },
    ReleaseSurface {
        id: "prebuilt-core",
        title: "Prebuilt core (binaries, Android ABIs, iOS XCFramework)",
        cadence: "tag",
        default_on_product_tag: true,
        workflow: Some("lane-prebuilt-core.yml"),
        tag_pattern: Some("v*"),
        secret_groups: &[],
        notes: "Rides `all`: it submits nothing to anybody, and a release whose core was never built for a required triple is a partial release (D-1020-G2).",
    },
    ReleaseSurface {
        id: "mobile",
        title: "Mobile (iOS / Android stores)",
        cadence: "store",
        default_on_product_tag: false,
        workflow: Some("lane-release-mobile.yml"),
        tag_pattern: None,
        secret_groups: &["mobile"],
        notes: "release.yml dispatch with surfaces: mobile only (J7) — never implied by a tag. Same product version stamp; ship is opt-in.",
    },
];

pub fn default_ship_surface_ids() -> Vec<String> {
    RELEASE_SURFACES
        .iter()
        .filter(|s| s.default_on_product_tag)
        .map(|s| s.id.to_owned())
        .collect()
}

pub fn resolve_ship_surfaces(ids: &[String]) -> Result<Vec<&'static ReleaseSurface>, String> {
    let mut surfaces = Vec::with_capacity(ids.len());
    for id in ids {
        match RELEASE_SURFACES.iter().find(|s| s.id == id.as_str()) {
            Some(s) => surfaces.push(s),
            None => {
                let known: Vec<&str> = RELEASE_SURFACES.iter().map(|x| x.id).collect();
                return Err(format!(
                    "Unknown surface \"{id}\". Known: {}",
                    known.join(", ")
                ));
            }
        }
    }
    Ok(surfaces)
}

pub fn build_surface_matrix(ship_ids: Option<Vec<String>>) -> SurfaceMatrix {
    let ship_this_cycle = ship_ids.unwrap_or_else(default_ship_surface_ids);
    let ship_set: BTreeSet<&str> = ship_this_cycle.iter().map(String::as_str).collect();
    let surfaces = RELEASE_SURFACES
        .iter()
        .map(|s| MatrixSurface {
            surface: s.clone(),
            in_default_ship: s.default_on_product_tag,
            in_this_ship: ship_set.contains(s.id),
        })
        .collect();
    SurfaceMatrix {
        product_version_rule: "One monorepo product semver. Surfaces may skip ship, never diverge stamps in git.",
        protocol_rule: "Runtime connect compares protocolVersion only (issue #512).",
        build_number_rule: "Stores: major*1e6+minor*1e3+patch from product version; never hand-set; resubmit = new patch.",
        default_ship: default_ship_surface_ids(),
        ship_this_cycle,
        surfaces,
    }
}

pub fn print_matrix(json: bool, ship_ids: Option<Vec<String>>) -> Result<(), String> {
    if let Some(ref ids) = ship_ids {
        resolve_ship_surfaces(ids)?;
    }
    let matrix = build_surface_matrix(ship_ids);
    if json {
        let out = serde_json::to_string_pretty(&matrix).map_err(|e| e.to_string())?;
        println!("{out}");
        return Ok(());
    }
    println!("Centraid release surfaces (#512)\n");
    println!("{}", matrix.product_version_rule);
    println!("{}", matrix.protocol_rule);
    println!("{}", matrix.build_number_rule);
    println!();
    println!("Default ship on v*: {}", matrix.default_ship.join(", "));
    println!("This cycle:         {}", matrix.ship_this_cycle.join(", "));
    println!();
    println!(
        "{:<16}{:<12}{:<10}{:<8}workflow",
        "id", "cadence", "default", "ship?"
    );
    println!("{}", "-".repeat(72));
    for s in &matrix.surfaces {
        println!(
            "{:<16}{:<12}{:<10}{:<8}{}",
            s.surface.id,
            s.surface.cadence,
            if s.in_default_ship { "yes" } else { "no" },
            if s.in_this_ship { "yes" } else { "no" },
            s.surface.workflow.unwrap_or("—"),
        );
    }
    println!("\nNotes:");
    for s in &matrix.surfaces {
        println!("  {}: {}", s.surface.id, s.surface.notes);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn default_ship_is_tag_surfaces_only() {
        let ids = default_ship_surface_ids();
        assert!(ids.iter().any(|s| s == "gateway-image"));
        assert!(ids.iter().any(|s| s == "prebuilt-core"));
        assert!(!ids.iter().any(|s| s == "mobile"));
    }

    #[test]
    fn resolve_ship_surfaces_rejects_unknown_ids() {
        assert!(resolve_ship_surfaces(&["gateway-image".into(), "nope".into()]).is_err());
        assert!(resolve_ship_surfaces(&["desktop".into()]).is_err());
        let good =
            resolve_ship_surfaces(&["gateway-image".into(), "mobile".into()]).expect("valid");
        assert_eq!(good.len(), 2);
    }

    #[test]
    fn build_surface_matrix_marks_ship_set() {
        let m = build_surface_matrix(Some(vec!["mobile".into()]));
        assert_eq!(m.ship_this_cycle, vec!["mobile"]);
        assert!(
            m.surfaces
                .iter()
                .find(|s| s.surface.id == "mobile")
                .expect("mobile")
                .in_this_ship
        );
        assert!(
            !m.surfaces
                .iter()
                .find(|s| s.surface.id == "gateway-image")
                .expect("gateway-image")
                .in_this_ship
        );
    }

    #[test]
    fn catalog_ids_are_unique() {
        let ids: BTreeSet<&str> = RELEASE_SURFACES.iter().map(|s| s.id).collect();
        assert_eq!(ids.len(), RELEASE_SURFACES.len());
    }

    #[test]
    fn every_surface_names_a_workflow_file_that_exists_on_disk() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("crates")
            .parent()
            .expect("root")
            .to_path_buf();
        let missing: Vec<String> = RELEASE_SURFACES
            .iter()
            .filter_map(|s| {
                let wf = s.workflow?;
                let path = root.join(".github/workflows").join(wf);
                (!path.is_file()).then(|| format!("{} → {wf}", s.id))
            })
            .collect();
        assert!(missing.is_empty(), "missing workflows: {missing:?}");
    }
}
