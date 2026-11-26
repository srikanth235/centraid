use std::path::Path;
use std::process::Command;

pub const CANDIDATE_REF: &str = "refs/candidates/latest";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateVerdict {
    pub ok: bool,
    pub message: String,
}

pub fn read_candidate_pointer<F>(run: F) -> Option<String>
where
    F: FnOnce(&str, &[&str]) -> Result<String, String>,
{
    let stdout = run("git", &["ls-remote", "origin", CANDIDATE_REF]).ok()?;
    let sha = stdout.split_whitespace().next().unwrap_or("");
    if sha.len() == 40 && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        Some(sha.to_owned())
    } else {
        None
    }
}

pub fn judge_candidate(
    head: &str,
    candidate: Option<&str>,
    allow_uncandidated: bool,
    reason: Option<&str>,
) -> CandidateVerdict {
    if let Some(cand) = candidate
        && head == cand
    {
        return CandidateVerdict {
            ok: true,
            message: format!("release-guard: {head} is the promoted candidate ({CANDIDATE_REF})"),
        };
    }
    if allow_uncandidated {
        let cand_note = match candidate {
            Some(c) => format!(" (which is {c})"),
            None => " (no candidate has ever been promoted)".to_owned(),
        };
        let why = reason
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .unwrap_or("(none given — say why in the PR description)");
        return CandidateVerdict {
            ok: true,
            message: format!(
                "release-guard: OVERRIDDEN with --allow-uncandidated. {head} is not {CANDIDATE_REF}{cand_note}. Reason given: {why}"
            ),
        };
    }
    let Some(cand) = candidate else {
        return CandidateVerdict {
            ok: false,
            message: format!(
                "release-guard: no candidate has ever been promoted, so nothing is releasable yet. `nightly.yml` moves {CANDIDATE_REF} on every green night; wait for one, or pass --allow-uncandidated with a reason."
            ),
        };
    };
    CandidateVerdict {
        ok: false,
        message: format!(
            "release-guard: HEAD is {head}, but the promoted candidate is {cand}. Releases ship builds a green nightly promoted — otherwise the release lanes only prove the tree BUILDS, which they would have done for a broken commit too. Release the candidate, wait for HEAD to be promoted, or pass --allow-uncandidated with a reason."
        ),
    }
}

pub fn assert_head_is_candidate(
    root: &Path,
    sha_override: Option<&str>,
    allow_uncandidated: bool,
    reason: Option<&str>,
) -> CandidateVerdict {
    let env_reason = std::env::var("CENTRAID_UNCANDIDATED_REASON").ok();
    let effective_reason = reason.or(env_reason.as_deref());
    let run_git = |file: &str, args: &[&str]| -> Result<String, String> {
        let out = Command::new(file)
            .args(args)
            .current_dir(root)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("{file} exited with {}", out.status));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    };
    let head = match sha_override {
        Some(sha) => sha.trim().to_owned(),
        None => run_git("git", &["rev-parse", "HEAD"])
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "(unknown)".to_owned()),
    };
    let candidate = read_candidate_pointer(run_git);
    let verdict = judge_candidate(
        &head,
        candidate.as_deref(),
        allow_uncandidated,
        effective_reason,
    );
    eprintln!("{}", verdict.message);
    verdict
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_promoted_sha_out_of_git_ls_remote() {
        let head = "a".repeat(40);
        assert_eq!(
            read_candidate_pointer(|_, _| Ok(format!("{head}\t{CANDIDATE_REF}\n"))),
            Some(head)
        );
        assert_eq!(read_candidate_pointer(|_, _| Ok(String::new())), None);
        assert_eq!(read_candidate_pointer(|_, _| Err("no remote".into())), None);
    }

    #[test]
    fn passes_when_head_is_promoted_candidate() {
        let head = "a".repeat(40);
        let verdict = judge_candidate(&head, Some(&head), false, None);
        assert!(verdict.ok);
        assert!(verdict.message.contains("is the promoted candidate"));
    }

    #[test]
    fn refuses_unpromoted_sha_and_names_both() {
        let head = "a".repeat(40);
        let other = "b".repeat(40);
        let verdict = judge_candidate(&head, Some(&other), false, None);
        assert!(!verdict.ok);
        assert!(verdict.message.contains(&head));
        assert!(verdict.message.contains(&other));
    }

    #[test]
    fn says_plainly_when_nothing_promoted() {
        let head = "a".repeat(40);
        let verdict = judge_candidate(&head, None, false, None);
        assert!(!verdict.ok);
        assert!(
            verdict
                .message
                .contains("no candidate has ever been promoted")
        );
    }

    #[test]
    fn escape_hatch_passes_and_prints_reason() {
        let head = "a".repeat(40);
        let other = "b".repeat(40);
        let verdict = judge_candidate(&head, Some(&other), true, Some("hotfix for a live outage"));
        assert!(verdict.ok);
        assert!(verdict.message.contains("hotfix for a live outage"));

        let no_reason = judge_candidate(&head, Some(&other), true, None);
        assert!(no_reason.ok);
        assert!(no_reason.message.contains("none given"));
    }
}
