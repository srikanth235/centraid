use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitInput {
    pub subject: String,
    pub body: String,
}

impl From<&str> for CommitInput {
    fn from(subject: &str) -> Self {
        Self {
            subject: subject.to_owned(),
            body: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCommit {
    pub kind: String,
    pub scope: Option<String>,
    pub text: String,
    pub issue: Option<String>,
    pub breaking: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BumpClassification {
    pub bump: Option<&'static str>,
    pub candidate: bool,
    pub rationale: String,
    pub breaking: bool,
    pub count: usize,
}

pub fn parse_commit(input: &CommitInput) -> Option<ParsedCommit> {
    let subject = input.subject.trim();
    let (header, rest) = subject.split_once(": ")?;
    if rest.is_empty() {
        return None;
    }
    let (header, bang) = match header.strip_suffix('!') {
        Some(h) => (h, true),
        None => (header, false),
    };
    let (kind, scope) = if let Some(open) = header.find('(') {
        let close = header.strip_suffix(')')?;
        let s = &close[open + 1..];
        if s.is_empty() || s.contains(')') {
            return None;
        }
        (&header[..open], Some(s.to_owned()))
    } else {
        (header, None)
    };
    if kind.is_empty() || !kind.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    if kind == "revert" || (kind == "chore" && scope.as_deref() == Some("release")) {
        return None;
    }
    let (text, issue) = strip_trailing_issue(rest);
    if text.is_empty() {
        return None;
    }
    let breaking = bang
        || input
            .body
            .lines()
            .any(|l| l.starts_with("BREAKING CHANGE:") || l.starts_with("BREAKING-CHANGE:"));
    Some(ParsedCommit {
        kind: kind.to_owned(),
        scope,
        text: text.to_owned(),
        issue,
        breaking,
    })
}

fn strip_trailing_issue(text: &str) -> (&str, Option<String>) {
    let Some(without_close) = text.strip_suffix(')') else {
        return (text, None);
    };
    let Some((prefix, num)) = without_close.rsplit_once(" (#") else {
        return (text, None);
    };
    if !num.is_empty()
        && !num.starts_with('0')
        && num.bytes().all(|b| b.is_ascii_digit())
        && !prefix.is_empty()
    {
        (prefix, Some(num.to_owned()))
    } else {
        (text, None)
    }
}

pub fn classify_bump(commits: &[CommitInput]) -> BumpClassification {
    let parsed: Vec<ParsedCommit> = commits.iter().filter_map(parse_commit).collect();
    if parsed.is_empty() {
        return BumpClassification {
            bump: None,
            candidate: false,
            rationale: "no releasable commits since the last tag; not a candidate".to_owned(),
            breaking: false,
            count: 0,
        };
    }
    let breaking = parsed.iter().any(|c| c.breaking);
    let feats = parsed.iter().filter(|c| c.kind == "feat").count();
    let note = if breaking {
        "; breaking marker present, but major is a human decision"
    } else {
        ""
    };
    let (bump, base) = if feats > 0 {
        ("minor", format!("{feats} feat commit(s) → minor"))
    } else {
        ("patch", "no feat commits → patch".to_owned())
    };
    BumpClassification {
        bump: Some(bump),
        candidate: true,
        rationale: format!("{base}{note}"),
        breaking,
        count: parsed.len(),
    }
}

pub fn release_notes(commits: &[CommitInput], version: &str) -> String {
    let parsed: Vec<ParsedCommit> = commits.iter().filter_map(parse_commit).collect();
    let mut features = Vec::new();
    let mut fixes = Vec::new();
    let mut other = Vec::new();
    for c in parsed {
        match c.kind.as_str() {
            "feat" => features.push(c),
            "fix" => fixes.push(c),
            _ => other.push(c),
        }
    }
    let mut sections = Vec::new();
    for (title, items) in [("Features", features), ("Fixes", fixes), ("Other", other)] {
        if items.is_empty() {
            continue;
        }
        let lines: Vec<String> = items
            .into_iter()
            .map(|c| {
                let scope = c.scope.map(|s| format!("**{s}**: ")).unwrap_or_default();
                let issue = c.issue.map(|i| format!(" (#{i})")).unwrap_or_default();
                let breaking = if c.breaking { " (breaking)" } else { "" };
                format!("- {scope}{}{issue}{breaking}", c.text)
            })
            .collect();
        sections.push(format!("## {title}\n\n{}", lines.join("\n")));
    }
    if sections.is_empty() {
        format!("Centraid {version}\n")
    } else {
        format!("{}\n", sections.join("\n\n"))
    }
}

pub fn commits_since_last_tag(cwd: &Path) -> Result<Vec<CommitInput>> {
    let tag_out = Command::new("git")
        .args(["describe", "--tags", "--abbrev=0", "--match", "v*"])
        .current_dir(cwd)
        .output();
    let range = match tag_out {
        Ok(out) if out.status.success() => {
            let tag = String::from_utf8_lossy(&out.stdout).trim().to_owned();
            if tag.is_empty() {
                None
            } else {
                Some(format!("{tag}..HEAD"))
            }
        }
        _ => None,
    };
    let mut cmd = Command::new("git");
    cmd.args(["log", "--no-merges", "--format=%s%x1f%b%x1e"]);
    if let Some(r) = range {
        cmd.arg(r);
    }
    let output = cmd.current_dir(cwd).output().context("run git log")?;
    if !output.status.success() {
        anyhow::bail!("git log exited with {}", output.status);
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let commits = raw
        .split('\x1E')
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(|r| {
            let (subject, body) = r.split_once('\x1F').unwrap_or((r, ""));
            CommitInput {
                subject: subject.to_owned(),
                body: body.to_owned(),
            }
        })
        .collect();
    Ok(commits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn inputs(list: &[&str]) -> Vec<CommitInput> {
        list.iter().map(|&s| CommitInput::from(s)).collect()
    }

    #[test]
    fn parse_commit_splits_type_scope_text_and_issue() {
        assert_eq!(
            parse_commit(&CommitInput::from("feat(photos): add albums (#12)")),
            Some(ParsedCommit {
                kind: "feat".into(),
                scope: Some("photos".into()),
                text: "add albums".into(),
                issue: Some("12".into()),
                breaking: false,
            })
        );
    }

    #[test]
    fn bang_or_breaking_change_body_marks_commit_breaking() {
        assert!(
            parse_commit(&CommitInput::from("fix!: drop old route (#3)"))
                .expect("parsed")
                .breaking
        );
        assert!(
            parse_commit(&CommitInput {
                subject: "fix: tweak (#4)".into(),
                body: "BREAKING CHANGE: format moved".into(),
            })
            .expect("parsed")
            .breaking
        );
    }

    #[test]
    fn merge_revert_fixup_and_release_commits_are_not_releasable() {
        for s in [
            "Merge branch 'x'",
            r#"Revert "feat: a (#1)""#,
            "revert: a (#1)",
            "fixup! fix: a (#1)",
            "chore(release): 0.4.3 (#9)",
        ] {
            assert_eq!(parse_commit(&CommitInput::from(s)), None, "{s}");
        }
    }

    #[test]
    fn any_feat_earns_minor_otherwise_patch_and_breaking_never_picks_major() {
        let minor = classify_bump(&inputs(&[
            "fix(a): x (#1)",
            "feat(b): y (#2)",
            "docs: z (#3)",
        ]));
        assert_eq!(minor.bump, Some("minor"));
        assert!(minor.candidate);

        for list in [
            vec!["fix(a): x (#1)"],
            vec!["docs: z (#3)", "chore(ci): w (#4)", "refactor: v (#5)"],
        ] {
            let patch = classify_bump(&inputs(&list));
            assert_eq!(patch.bump, Some("patch"));
            assert!(patch.candidate);
        }

        let brk = classify_bump(&inputs(&["fix!: break (#1)"]));
        assert_eq!(brk.bump, Some("patch"));
        assert!(brk.breaking);
        assert!(brk.rationale.contains("major is a human decision"));
        assert_eq!(
            classify_bump(&inputs(&["feat!: break (#2)"])).bump,
            Some("minor")
        );

        for list in [vec![], vec!["chore(release): 0.4.3 (#9)"], vec!["Merge x"]] {
            let none = classify_bump(&inputs(&list));
            assert_eq!(none.bump, None);
            assert!(!none.candidate);
        }
    }

    #[test]
    fn release_notes_groups_features_fixes_other_and_keeps_issues() {
        let body = release_notes(
            &inputs(&[
                "docs(readme): clarify (#5)",
                "fix: crash on open (#2)",
                "feat(photos): add albums (#1)",
                "chore(release): 0.4.3 (#9)",
                "perf(core): faster open (#6)",
            ]),
            "0.5.0",
        );
        assert_eq!(
            body,
            "## Features\n\n- **photos**: add albums (#1)\n\n## Fixes\n\n- crash on open (#2)\n\n## Other\n\n- **readme**: clarify (#5)\n- **core**: faster open (#6)\n"
        );
        assert!(!release_notes(&inputs(&["fix: a (#1)"]), "1.0.1").contains("## Features"));
        assert_eq!(release_notes(&[], "1.0.1"), "Centraid 1.0.1\n");
    }

    #[test]
    fn commits_since_last_tag_reads_after_newest_v_tag() {
        let dir = tempfile::tempdir().expect("tempdir");
        let git = |args: &[&str]| {
            let mut cmd = Command::new("git");
            for key in [
                "GIT_DIR",
                "GIT_WORK_TREE",
                "GIT_COMMON_DIR",
                "GIT_INDEX_FILE",
                "GIT_PREFIX",
                "GIT_OBJECT_DIRECTORY",
                "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            ] {
                cmd.env_remove(key);
            }
            let status = cmd
                .args(args)
                .current_dir(dir.path())
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .env("GIT_AUTHOR_NAME", "fixture")
                .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
                .env("GIT_COMMITTER_NAME", "fixture")
                .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
                .status()
                .expect("git");
            assert!(status.success(), "git {args:?}");
        };
        git(&["init", "-q"]);
        fs::write(dir.path().join("f"), "1").expect("write");
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "feat: old feature (#1)"]);
        let before: Vec<String> = commits_since_last_tag(dir.path())
            .expect("commits")
            .into_iter()
            .map(|c| c.subject)
            .collect();
        assert_eq!(before, vec!["feat: old feature (#1)"]);

        git(&["tag", "-a", "v0.1.0", "-m", "v0.1.0"]);
        fs::write(dir.path().join("f"), "2").expect("write");
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "fix: after the tag (#2)"]);
        let after: Vec<String> = commits_since_last_tag(dir.path())
            .expect("commits")
            .into_iter()
            .map(|c| c.subject)
            .collect();
        assert_eq!(after, vec!["fix: after the tag (#2)"]);
    }
}
