use super::{ANDROID, Artifacts, IOS, Tokens};
use anyhow::{Result, ensure};
use std::{collections::BTreeMap, fs, path::Path};

pub(super) fn emit(root: &Path, tokens: &Tokens, out: &mut Artifacts) -> Result<()> {
    out.json(
        "design/native-fonts.json",
        &serde_json::json!(
            tokens
                .fonts
                .iter()
                .map(|font| serde_json::json!({"fileName":font.file}))
                .collect::<Vec<_>>()
        ),
    )?;
    for font in &tokens.fonts {
        ensure!(
            !font.file.contains('/') && !font.file.contains(".."),
            "font filename must be local"
        );
        let bytes = fs::read(root.join("design/fonts").join(&font.file))?;
        out.0.insert(
            format!("{IOS}/Resources/Fonts/{}", font.file),
            bytes.clone(),
        );
        out.0.insert(
            format!("{ANDROID}/res/font/{}.ttf", font.android),
            bytes.clone(),
        );
        for site in ["home", "docs"] {
            out.0.insert(
                format!("scripts/{site}-site/public/assets/fonts/{}", font.file),
                bytes.clone(),
            );
        }
    }
    Ok(())
}

pub(super) fn swift(tokens: &Tokens) -> String {
    let mut families: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for font in &tokens.fonts {
        families
            .entry(&font.family)
            .or_default()
            .push(format!("{}: \"{}\"", font.weight, font.postscript));
    }
    let mut out = String::from("\npublic let centraidTypeFaces: [String: [Int: String]] = [\n");
    for (family, weights) in families {
        out.push_str(&format!("    \"{family}\": [{}],\n", weights.join(", ")));
    }
    out.push_str("]\npublic let centraidFontFiles: [String] = [\n");
    for font in &tokens.fonts {
        out.push_str(&format!("    \"{}\",\n", font.file));
    }
    out.push_str("]\n\n");
    out
}

pub(super) fn kotlin(tokens: &Tokens) -> String {
    let mut families: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for font in &tokens.fonts {
        families
            .entry(&font.family)
            .or_default()
            .push(format!("{} to \"{}\"", font.weight, font.android));
    }
    let mut out =
        String::from("\npublic val NATIVE_TYPE_FACES: Map<String, Map<Int, String>> = mapOf(\n");
    for (family, weights) in families {
        out.push_str(&format!(
            "    \"{family}\" to mapOf({}),\n",
            weights.join(", ")
        ));
    }
    out.push_str(")\n\n");
    out
}
