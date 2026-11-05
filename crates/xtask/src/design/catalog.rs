//! Native lookups for app identities and the shared icon paths.
use std::{collections::BTreeMap, fs, path::Path};

use anyhow::{Context, Result};
use serde_json::{Value, json};

use super::{ANDROID, Artifacts, HEADER, IOS, Tokens, android_color, snake};

pub(super) fn emit(root: &Path, tokens: &Tokens, out: &mut Artifacts) -> Result<()> {
    let icons: BTreeMap<String, Vec<Value>> =
        serde_json::from_str(&fs::read_to_string(root.join("design/icons.json"))?)?;
    let mut apps = Vec::new();
    for id in [
        "notes", "people", "photos", "locker", "docs", "agenda", "money", "health",
    ] {
        let manifest: Value = serde_json::from_str(&fs::read_to_string(
            root.join(format!("crates/apps/{id}/manifest.json")),
        )?)?;
        apps.push(json!({"id":id, "name":manifest["name"], "desc":manifest["description"], "iconKey":manifest["iconKey"], "colorKey":id}));
    }
    let mut swift = format!(
        "{HEADER}import SwiftUI\n\npublic struct CentraidAppMeta: Sendable {{\n    public let id: String\n    public let name: String\n    public let desc: String\n    public let iconKey: String\n    public let colorKey: String\n}}\npublic struct CentraidAppMark: Sendable {{\n    public let hue: Color\n    public let chipBackground: Color\n    public let markColor: Color\n}}\npublic struct CentraidIconPath: Sendable {{\n    public let d: String\n    public let filled: Bool\n    public let evenOdd: Bool\n}}\npublic enum CentraidCatalog {{\n    public static let apps: [CentraidAppMeta] = [\n"
    );
    let mut kotlin = format!(
        "{HEADER}package dev.centraid.design\n\npublic data class NativeApp(\n    public val id: String,\n    public val name: String,\n    public val desc: String,\n    public val iconKey: String,\n    public val colorKey: String,\n)\npublic data class NativeAppMark(\n    public val hue: Long,\n    public val chipBackground: Long,\n    public val markColor: Long,\n)\npublic data class NativeIconPath(\n    public val d: String,\n    public val filled: Boolean,\n    public val evenOdd: Boolean,\n)\npublic object CentraidCatalog {{\n    public val apps: List<NativeApp> = listOf(\n"
    );
    for app in &apps {
        let fields = ["id", "name", "desc", "iconKey", "colorKey"];
        let swift_fields: Vec<_> = fields
            .iter()
            .map(|key| format!("{key}: {}", app[key]))
            .collect();
        let kotlin_fields: Vec<_> = fields
            .iter()
            .map(|key| format!("{key} = {}", app[key].to_string().replace('$', "\\$")))
            .collect();
        swift.push_str(&format!(
            "        CentraidAppMeta({}),\n",
            swift_fields.join(", ")
        ));
        kotlin.push_str(&format!(
            "        NativeApp({}),\n",
            kotlin_fields.join(", ")
        ));
    }
    swift.push_str("    ]\n    public static let byID: [String: CentraidAppMeta] = Dictionary(uniqueKeysWithValues: apps.map { ($0.id, $0) })\n");
    kotlin.push_str(
        "    )\n    public val byId: Map<String, NativeApp> = apps.associateBy { it.id }\n",
    );
    let mut marks = BTreeMap::new();
    for dark in [false, true] {
        let scheme = if dark { "dark" } else { "light" };
        swift.push_str(&format!(
            "    public static let {scheme}Marks: [String: CentraidAppMark] = [\n"
        ));
        kotlin.push_str(&format!(
            "    public val {scheme}Marks: Map<String, NativeAppMark> = mapOf(\n"
        ));
        let mut entries = BTreeMap::new();
        for app in &apps {
            let id = app["id"].as_str().context("app id")?;
            let color = &tokens.apps[id];
            let text = if dark { &color.dark_text } else { &color.light };
            let tint = if dark {
                &color.dark_tint
            } else {
                &color.light_tint
            };
            let (chip, glyph, chip_role, glyph_role) =
                if let Some(tile) = color.tile.as_ref().filter(|tile| *tile != &color.light) {
                    (tile, tokens.tile_ink(tile), "Tile", "OnTile")
                } else {
                    (tint, text, "Tint", "Text")
                };
            swift.push_str(&format!("        \"{id}\": CentraidAppMark(hue: Color(\"design_{id}Text\"), chipBackground: Color(\"design_{id}{chip_role}\"), markColor: Color(\"design_{id}{glyph_role}\")),\n"));
            kotlin.push_str(&format!("        \"{id}\" to NativeAppMark(hue = 0x{}L, chipBackground = 0x{}L, markColor = 0x{}L),\n", android_color(text)?, android_color(chip)?, android_color(glyph)?));
            entries.insert(
                id,
                json!({"hue":text, "chipBackground":chip, "markColor":glyph}),
            );
        }
        marks.insert(scheme, entries);
        swift.push_str("    ]\n");
        kotlin.push_str("    )\n");
    }
    swift.push_str("    public static let icons: [String: [CentraidIconPath]] = [\n");
    kotlin.push_str("    public val icons: Map<String, List<NativeIconPath>> = mapOf(\n");
    for (name, paths) in &icons {
        swift.push_str(&format!("        \"{name}\": [\n"));
        kotlin.push_str(&format!("        \"{name}\" to listOf(\n"));
        for path in paths {
            let d = serde_json::to_string(path["d"].as_str().context("icon path has no d")?)?;
            let filled = path["fill"] == "currentColor";
            let even_odd = path["fillRule"] == "evenodd";
            swift.push_str(&format!(
                "            CentraidIconPath(d: {d}, filled: {filled}, evenOdd: {even_odd}),\n"
            ));
            kotlin.push_str(&format!(
                "            NativeIconPath(d = {d}, filled = {filled}, evenOdd = {even_odd}),\n"
            ));
        }
        swift.push_str("        ],\n");
        kotlin.push_str("        ),\n");
    }
    swift.push_str("    ]\n}\n\npublic enum CentraidGeometry {\n");
    kotlin.push_str("    )\n}\n\npublic object CentraidGeometry {\n");
    for (key, value) in &tokens.geometry {
        swift.push_str(&format!("    public static let {key}: CGFloat = {value}\n"));
        let is_double = matches!(
            key.as_str(),
            "appMarkSmallStroke"
                | "appMarkStroke"
                | "iconChipRadiusRatio"
                | "iconChipTintDark"
                | "iconChipTintLight"
        );
        let (ty, literal) = if is_double {
            ("Double", format!("{value:?}"))
        } else {
            ("Int", value.to_string())
        };
        kotlin.push_str(&format!(
            "    public const val {}: {ty} = {literal}\n",
            snake(key).to_uppercase()
        ));
    }
    swift.push_str("}\n");
    kotlin.push_str("}\n");
    out.text(format!("{IOS}/Design/Catalog.swift"), swift);
    out.text(
        format!("{ANDROID}/kotlin/dev/centraid/android/design/Catalog.kt"),
        kotlin,
    );
    out.json("design/native-catalog.json", &json!({"$generatedBy":"cargo xtask design", "apps":apps, "icons":icons,"marks":marks,"geometry":tokens.geometry}))?;
    Ok(())
}
