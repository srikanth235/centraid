use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use anyhow::Result;

use crate::rules::RuleReport;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillIssue {
    pub file: String,
    pub message: String,
}

fn extract_frontmatter(source: &str) -> Option<(&str, &str)> {
    let rest = source
        .strip_prefix("---\r\n")
        .or_else(|| source.strip_prefix("---\n"))?;
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" {
            let yaml = rest[..offset].trim_end_matches(['\r', '\n']);
            let body = &rest[offset + line.len()..];
            return Some((yaml, body));
        }
        offset += line.len();
    }
    None
}

fn parse_yaml_mapping(yaml: &str) -> Result<BTreeMap<String, String>, String> {
    let lines: Vec<&str> = yaml.lines().collect();
    let mut map = BTreeMap::new();
    let mut i = 0;
    while i < lines.len() {
        let raw = lines[i];
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            i += 1;
            continue;
        }
        if raw.starts_with(' ') || raw.starts_with('\t') {
            return Err(format!("unexpected indentation at line {}", i + 1));
        }
        let Some((key_raw, val_raw)) = raw.split_once(':') else {
            return Err(format!("expected `key: value` at line {}", i + 1));
        };
        let key = key_raw.trim();
        if key.is_empty() || key.contains(' ') {
            return Err(format!("invalid key `{key}` at line {}", i + 1));
        }
        let val = val_raw.trim();
        if matches!(val, ">" | ">-" | ">+" | "|" | "|-" | "|+") {
            let mut block = Vec::new();
            i += 1;
            let mut indent: Option<usize> = None;
            while i < lines.len() {
                let l = lines[i];
                if l.trim().is_empty() {
                    block.push("");
                    i += 1;
                    continue;
                }
                let leading = l.len() - l.trim_start_matches(' ').len();
                if leading == 0 {
                    break;
                }
                let base = *indent.get_or_insert(leading);
                let cut = base.min(leading);
                block.push(&l[cut..]);
                i += 1;
            }
            let joined = if val.starts_with('>') {
                block
                    .into_iter()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
            } else {
                block.join("\n")
            };
            map.insert(key.to_owned(), joined);
            continue;
        }
        let parsed = parse_yaml_scalar(val, i + 1)?;
        map.insert(key.to_owned(), parsed);
        i += 1;
    }
    if map.is_empty() {
        return Err("frontmatter must be a YAML mapping".to_owned());
    }
    Ok(map)
}

fn parse_yaml_scalar(val: &str, line_no: usize) -> Result<String, String> {
    if val.is_empty() {
        return Ok(String::new());
    }
    if val.starts_with('\'') {
        if val.len() >= 2 && val.ends_with('\'') {
            return Ok(val[1..val.len() - 1].replace("''", "'"));
        }
        return Err(format!(
            "unterminated single-quoted string at line {line_no}"
        ));
    }
    if val.starts_with('"') {
        if val.len() >= 2 && val.ends_with('"') {
            return Ok(val[1..val.len() - 1].to_owned());
        }
        return Err(format!(
            "unterminated double-quoted string at line {line_no}"
        ));
    }
    if val.starts_with('[') && !val.ends_with(']') {
        return Err(format!("unterminated flow sequence at line {line_no}"));
    }
    if val.starts_with('{') && !val.ends_with('}') {
        return Err(format!("unterminated flow mapping at line {line_no}"));
    }
    if val.contains(": ") || val.ends_with(':') {
        return Err(format!(
            "unquoted colon followed by space at line {line_no}"
        ));
    }
    Ok(val.to_owned())
}

fn markdown_links(body: &str) -> Vec<String> {
    let mut links = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j] != b']' && bytes[j] != b'\n' {
                j += 1;
            }
            if j + 1 < bytes.len() && bytes[j] == b']' && bytes[j + 1] == b'(' {
                let start = j + 2;
                let mut k = start;
                while k < bytes.len() && bytes[k] != b')' && bytes[k] != b'\n' {
                    k += 1;
                }
                if k < bytes.len() && bytes[k] == b')' {
                    links.push(body[start..k].trim().to_owned());
                    i = k + 1;
                    continue;
                }
            }
        }
        i += 1;
    }
    links
}

fn has_router_table(body: &str) -> bool {
    let lines: Vec<&str> = body.lines().map(str::trim).collect();
    for window in lines.windows(3) {
        if window[0].starts_with('|')
            && window[1].starts_with('|')
            && window[1].contains("---")
            && window[2].starts_with('|')
            && window[2].contains(".md)")
        {
            return true;
        }
    }
    false
}

pub fn check_skills(root: &Path) -> Result<(usize, Vec<SkillIssue>)> {
    let skills_dir = root.join(".claude/skills");
    if !skills_dir.is_dir() {
        return Ok((0, Vec::new()));
    }
    let mut entries: Vec<String> = fs::read_dir(&skills_dir)?
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    entries.sort();

    let mut issues = Vec::new();
    let mut scanned = 0usize;
    for directory in entries {
        let relative = format!(".claude/skills/{directory}/SKILL.md");
        let abs = root.join(&relative);
        let Ok(source) = fs::read_to_string(&abs) else {
            issues.push(SkillIssue {
                file: relative,
                message: "missing SKILL.md".to_owned(),
            });
            continue;
        };
        scanned += 1;
        let Some((yaml, body)) = extract_frontmatter(&source) else {
            issues.push(SkillIssue {
                file: relative,
                message: "missing YAML frontmatter".to_owned(),
            });
            continue;
        };
        let fields = match parse_yaml_mapping(yaml) {
            Ok(m) => m,
            Err(err) => {
                issues.push(SkillIssue {
                    file: relative,
                    message: format!("invalid YAML frontmatter: {err}"),
                });
                continue;
            }
        };
        if fields.get("name").map(String::as_str) != Some(directory.as_str()) {
            issues.push(SkillIssue {
                file: relative.clone(),
                message: format!("name must match skill directory ({directory})"),
            });
        }
        if fields
            .get("description")
            .is_none_or(|d| d.trim().is_empty())
        {
            issues.push(SkillIssue {
                file: relative.clone(),
                message: "description must be a nonempty string".to_owned(),
            });
        }
        let skill_dir = skills_dir.join(&directory);
        for target in markdown_links(body) {
            if target.is_empty()
                || target.starts_with('#')
                || target.starts_with("http://")
                || target.starts_with("https://")
                || target.starts_with("mailto:")
            {
                continue;
            }
            let path_part = target.split('#').next().unwrap_or("");
            if path_part.is_empty() {
                continue;
            }
            if !skill_dir.join(path_part).exists() {
                issues.push(SkillIssue {
                    file: relative.clone(),
                    message: format!("broken link target `{target}`"),
                });
            }
        }
        if !has_router_table(body) {
            issues.push(SkillIssue {
                file: relative,
                message: "missing router table linking to skill pages".to_owned(),
            });
        }
    }
    Ok((scanned, issues))
}

pub fn rule_report(root: &Path) -> RuleReport {
    const NAME: &str = "skills";
    if !root.join(".claude/skills").is_dir() {
        return RuleReport::pending(NAME, "no .claude/skills directory");
    }
    match check_skills(root) {
        Ok((scanned, issues)) => RuleReport::applied(
            NAME,
            scanned,
            issues
                .into_iter()
                .map(|i| format!("{}: {}", i.file, i.message))
                .collect(),
        ),
        Err(err) => RuleReport::applied(NAME, 0, vec![format!("skills: {err:#}")]),
    }
}

pub fn run_cli(root: &Path) -> Result<bool> {
    let (_, issues) = check_skills(root)?;
    for issue in &issues {
        eprintln!("{}: {}", issue.file, issue.message);
    }
    if issues.is_empty() {
        println!("skills: frontmatter, links and router tables are valid for every skill");
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROUTER: &str = "\n| Topic | Read |\n| --- | --- |\n| Guide | [guide.md](guide.md) |\n";

    fn fixture(skills: &[(&str, Option<&str>)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        for (name, body) in skills {
            let skill_dir = dir.path().join(".claude/skills").join(name);
            fs::create_dir_all(&skill_dir).expect("mkdir");
            fs::write(skill_dir.join("guide.md"), "# Guide\n").expect("write guide");
            if let Some(text) = body {
                fs::write(skill_dir.join("SKILL.md"), text).expect("write SKILL.md");
            }
        }
        dir
    }

    #[test]
    fn accepts_block_yaml_containing_colon_space() {
        let body = format!(
            "---\nname: alpha\ndescription: >-\n  How to change the vault model: add or change a kind.\n---\n{ROUTER}"
        );
        let dir = fixture(&[("alpha", Some(&body))]);
        let (_, issues) = check_skills(dir.path()).expect("check");
        assert!(issues.is_empty(), "{issues:?}");
    }

    #[test]
    fn rejects_malformed_yaml_including_unquoted_colon_space() {
        let dir = fixture(&[
            (
                "malformed",
                Some("---\nname: malformed\ndescription: How to change: add a field\n---\n"),
            ),
            (
                "broken",
                Some("---\nname: [unterminated\ndescription: x\n---\n"),
            ),
        ]);
        let (_, issues) = check_skills(dir.path()).expect("check");
        let count = issues
            .iter()
            .filter(|i| i.message.contains("invalid YAML frontmatter"))
            .count();
        assert_eq!(count, 2, "{issues:?}");
    }

    #[test]
    fn reports_directory_name_mismatch_and_blank_or_missing_descriptions() {
        let mismatch = format!("---\nname: other\ndescription: present\n---\n{ROUTER}");
        let blank = format!("---\nname: blank\ndescription: '  '\n---\n{ROUTER}");
        let missing = format!("---\nname: missing\n---\n{ROUTER}");
        let dir = fixture(&[
            ("mismatch", Some(&mismatch)),
            ("blank", Some(&blank)),
            ("missing", Some(&missing)),
        ]);
        let (_, issues) = check_skills(dir.path()).expect("check");
        let joined: Vec<String> = issues
            .iter()
            .map(|i| format!("{}: {}", i.file, i.message))
            .collect();
        assert!(
            joined
                .iter()
                .any(|s| s.contains("name must match skill directory"))
        );
        let desc_count = joined
            .iter()
            .filter(|s| s.contains("description must be a nonempty string"))
            .count();
        assert_eq!(desc_count, 2, "{joined:?}");
    }

    #[test]
    fn reports_missing_skill_md() {
        let dir = fixture(&[("absent", None)]);
        let (_, issues) = check_skills(dir.path()).expect("check");
        assert_eq!(issues[0].message, "missing SKILL.md");
    }

    #[test]
    fn reports_broken_link_and_missing_router_table() {
        let broken_link = "---\nname: alpha\ndescription: ok\n---\n| Topic | Read |\n| --- | --- |\n| Nope | [nope.md](nope.md) |\n";
        let no_table = "---\nname: beta\ndescription: ok\n---\nPlain prose only.\n";
        let dir = fixture(&[("alpha", Some(broken_link)), ("beta", Some(no_table))]);
        let (_, issues) = check_skills(dir.path()).expect("check");
        assert!(
            issues
                .iter()
                .any(|i| i.message.contains("broken link target `nope.md`")),
            "{issues:?}"
        );
        assert!(
            issues
                .iter()
                .any(|i| i.message.contains("missing router table")),
            "{issues:?}"
        );
    }
}
