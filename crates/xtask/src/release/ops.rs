use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::{Value, json};

use crate::release::candidate::assert_head_is_candidate;
use crate::release::commits::{classify_bump, commits_since_last_tag, release_notes};
use crate::release::surfaces::{
    build_surface_matrix, default_ship_surface_ids, resolve_ship_surfaces,
};

const FIXED_WORKSPACES: [&str; 2] = ["desktop/electron", "extension"];
const MAX_SAFE_INT: u64 = 9_007_199_254_740_991;

pub fn parse_semver_triple(version: &str) -> Result<(u64, u64, u64)> {
    let trimmed = version.trim();
    let core = trimmed.split('-').next().unwrap_or(trimmed);
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        bail!("unparseable version {version}");
    }
    let major: u64 = parts[0].parse().context("parse major")?;
    let minor: u64 = parts[1].parse().context("parse minor")?;
    let patch: u64 = parts[2].parse().context("parse patch")?;
    Ok((major, minor, patch))
}

pub fn is_strict_semver(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

pub fn native_build_number(version: &str) -> Result<u64> {
    let (major, minor, patch) = parse_semver_triple(version)
        .map_err(|_| anyhow::anyhow!("unparseable semver: {version}"))?;
    Ok(major * 1_000_000 + minor * 1_000 + patch)
}

pub fn bump_semver(current: &str, kind: &str) -> Result<String> {
    let (maj, mut min, mut pat) = parse_semver_triple(current)?;
    match kind {
        "major" => bail!("agents never propose major before 1.0 (D4/F1)"),
        "minor" => {
            min += 1;
            pat = 0;
        }
        _ => {
            pat += 1;
        }
    }
    Ok(format!("{maj}.{min}.{pat}"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncVersionsReport {
    pub prev: String,
    pub version: String,
    pub build: u64,
    pub dry_run: bool,
    pub workspaces: Vec<String>,
}

fn collect_package_jsons(root: &Path) -> Vec<PathBuf> {
    let mut out = vec![root.join("package.json")];
    let packages = root.join("packages");
    if packages.is_dir()
        && let Ok(entries) = fs::read_dir(&packages)
    {
        let mut names: Vec<_> = entries.flatten().map(|e| e.path()).collect();
        names.sort();
        for dir in names {
            let p = dir.join("package.json");
            if p.is_file() {
                out.push(p);
            }
        }
    }
    for rel in FIXED_WORKSPACES {
        let p = root.join(rel).join("package.json");
        if p.is_file() {
            out.push(p);
        }
    }
    out
}

pub fn run_sync_versions(
    root: &Path,
    version: Option<&str>,
    dry_run: bool,
) -> Result<SyncVersionsReport> {
    let root_pkg_path = root.join("package.json");
    let root_text = fs::read_to_string(&root_pkg_path)
        .with_context(|| format!("read {}", root_pkg_path.display()))?;
    let root_pkg: Value = serde_json::from_str(&root_text).context("parse package.json")?;
    let prev = root_pkg
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("package.json has no version"))?
        .to_owned();
    let ver = version.unwrap_or(&prev).to_owned();
    if !is_strict_semver(&ver) {
        bail!("unparseable version {ver}");
    }
    let build = native_build_number(&ver)?;
    let mut workspaces = Vec::new();
    for p in collect_package_jsons(root) {
        let text = fs::read_to_string(&p).with_context(|| format!("read {}", p.display()))?;
        let mut doc: Value =
            serde_json::from_str(&text).with_context(|| format!("parse {}", p.display()))?;
        let matches_prev = doc.get("version").and_then(Value::as_str) == Some(prev.as_str());
        if matches_prev || p == root_pkg_path {
            if let Some(obj) = doc.as_object_mut() {
                obj.insert("version".to_owned(), Value::String(ver.clone()));
            }
            if !dry_run {
                let rendered = format!("{}\n", serde_json::to_string_pretty(&doc)?);
                fs::write(&p, rendered).with_context(|| format!("write {}", p.display()))?;
            }
            let rel = p
                .strip_prefix(root)
                .unwrap_or(&p)
                .to_string_lossy()
                .replace('\\', "/");
            workspaces.push(rel);
        }
    }
    Ok(SyncVersionsReport {
        prev,
        version: ver,
        build,
        dry_run,
        workspaces,
    })
}

pub fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn format_iso_utc(epoch_ms: i64) -> String {
    let total_secs = epoch_ms.div_euclid(1000);
    let ms = epoch_ms.rem_euclid(1000);
    let days = total_secs.div_euclid(86_400);
    let secs_of_day = total_secs.rem_euclid(86_400);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;

    // Howard Hinnant's civil-from-days algorithm (UTC proleptic Gregorian).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{ms:03}Z")
}

pub fn restamp_release_date(yml: &str, hours: f64, now_ms: i64) -> Result<(String, String)> {
    if !hours.is_finite() || hours < 0.0 {
        bail!("hours must be >= 0, got {hours}");
    }
    let delta_ms = (hours * 3_600_000.0).round() as i64;
    let target = format_iso_utc(now_ms - delta_ms);
    let replacement = format!("releaseDate: '{target}'");

    let has_release_date = yml.lines().any(|l| l.starts_with("releaseDate:"));
    if has_release_date {
        let mut out = String::with_capacity(yml.len() + 32);
        let mut replaced = false;
        for segment in yml.split_inclusive('\n') {
            let trimmed = segment.trim_end_matches(['\r', '\n']);
            let ending = &segment[trimmed.len()..];
            if !replaced && trimmed.starts_with("releaseDate:") {
                out.push_str(&replacement);
                out.push_str(ending);
                replaced = true;
            } else {
                out.push_str(segment);
            }
        }
        return Ok((out, target));
    }

    let mut out = String::with_capacity(yml.len() + 48);
    let mut inserted = false;
    for segment in yml.split_inclusive('\n') {
        out.push_str(segment);
        let trimmed = segment.trim_end_matches(['\r', '\n']);
        if !inserted && trimmed.starts_with("version:") {
            out.push_str(&replacement);
            out.push('\n');
            inserted = true;
        }
    }
    if !inserted {
        out = format!("{}\n{replacement}\n", yml.trim_end());
    }
    Ok((out, target))
}

#[derive(Debug, Clone, Serialize)]
pub struct SecretGroupReport {
    pub present: usize,
    pub total: usize,
    pub ready: bool,
    pub secrets: BTreeMap<String, &'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SecretsReport {
    pub note: &'static str,
    pub groups: BTreeMap<String, SecretGroupReport>,
}

pub fn probe_secrets() -> SecretsReport {
    let defs: &[(&str, &[&str])] = &[
        (
            "desktop-apple",
            &["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
        ),
        (
            "desktop-azure",
            &[
                "AZURE_TENANT_ID",
                "AZURE_CLIENT_ID",
                "AZURE_CLIENT_SECRET",
                "AZURE_CODE_SIGNING_ACCOUNT",
                "AZURE_CERT_PROFILE",
            ],
        ),
        ("gateway-image", &["GITHUB_TOKEN"]),
        (
            "mobile",
            &[
                "ANDROID_KEYSTORE_BASE64",
                "ANDROID_KEYSTORE_PASSWORD",
                "ANDROID_KEY_ALIAS",
                "PLAY_SERVICE_ACCOUNT_JSON",
                "APPLE_API_KEY_ID",
                "APPLE_API_ISSUER_ID",
                "APPLE_API_PRIVATE_KEY",
            ],
        ),
    ];
    let mut groups = BTreeMap::new();
    for &(group, names) in defs {
        let mut secrets = BTreeMap::new();
        let mut present = 0usize;
        for &name in names {
            let ok = std::env::var(name).is_ok_and(|v| !v.is_empty());
            secrets.insert(name.to_owned(), if ok { "present" } else { "absent" });
            if ok {
                present += 1;
            }
        }
        groups.insert(
            group.to_owned(),
            SecretGroupReport {
                present,
                total: names.len(),
                ready: present == names.len(),
                secrets,
            },
        );
    }
    SecretsReport {
        note: "values never printed",
        groups,
    }
}

pub fn run_verify_secrets(strict: bool) -> Result<bool> {
    let report = probe_secrets();
    println!("{}", serde_json::to_string_pretty(&report)?);
    if strict {
        let missing = report.groups.values().filter(|g| !g.ready).count();
        if missing > 0 {
            eprintln!("{missing} secret group(s) incomplete — enrollment residual");
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn run_classify(
    root: &Path,
    require_candidate: bool,
    sha: Option<&str>,
    allow_uncandidated: bool,
    reason: Option<&str>,
) -> Result<bool> {
    if require_candidate {
        let verdict = assert_head_is_candidate(root, sha, allow_uncandidated, reason);
        if !verdict.ok {
            return Ok(false);
        }
    }
    let commits = commits_since_last_tag(root)?;
    let result = classify_bump(&commits);
    println!("{}", serde_json::to_string(&result)?);
    Ok(true)
}

pub fn run_notes(root: &Path, version: &str, out: Option<&Path>) -> Result<()> {
    let commits = commits_since_last_tag(root)?;
    let body = release_notes(&commits, version);
    if let Some(dest) = out {
        fs::write(dest, &body).with_context(|| format!("write {}", dest.display()))?;
    } else {
        print!("{body}");
    }
    Ok(())
}

pub fn run_prepare(
    root: &Path,
    allow_dirty: bool,
    skip_check: bool,
    allow_uncandidated: bool,
    reason: Option<&str>,
) -> Result<Option<Value>> {
    let verdict = assert_head_is_candidate(root, None, allow_uncandidated, reason);
    if !verdict.ok {
        return Ok(None);
    }
    if !allow_dirty {
        let out = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(root)
            .output()
            .context("git status")?;
        if !String::from_utf8_lossy(&out.stdout).trim().is_empty() {
            eprintln!("working tree not clean; commit or pass --allow-dirty");
            return Ok(None);
        }
    }
    if !skip_check {
        eprintln!("running cargo xtask gate --profile pr …");
        let status = Command::new("cargo")
            .args(["xtask", "gate", "--profile", "pr"])
            .current_dir(root)
            .status()
            .context("run cargo xtask gate --profile pr")?;
        if !status.success() {
            eprintln!("the pr gate failed — fix before preparing a release");
            return Ok(None);
        }
    }
    let pkg: Value = serde_json::from_str(
        &fs::read_to_string(root.join("package.json")).context("read package.json")?,
    )?;
    let current = pkg
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("package.json has no version"))?
        .to_owned();
    let class_out = classify_bump(&commits_since_last_tag(root)?);
    if !class_out.candidate {
        eprintln!("{}", class_out.rationale);
        return Ok(None);
    }
    let bump = class_out.bump.unwrap_or("patch");
    let next = bump_semver(&current, bump)?;
    let default_ship = default_ship_surface_ids();
    let matrix = build_surface_matrix(Some(default_ship.clone()));
    let secrets = probe_secrets();

    let continuous: Vec<&str> = matrix
        .surfaces
        .iter()
        .filter(|s| s.surface.cadence == "continuous")
        .map(|s| s.surface.id)
        .collect();
    let store_opt_in: Vec<&str> = matrix
        .surfaces
        .iter()
        .filter(|s| s.surface.cadence == "store")
        .map(|s| s.surface.id)
        .collect();

    let report = json!({
        "current": current,
        "next": next,
        "bump": bump,
        "rationale": class_out.rationale,
        "versioning": {
            "product": "One monorepo semver; stamp all packages; surfaces may skip ship not stamps.",
            "buildNumber": "Script-derived major*1e6+minor*1e3+patch; resubmit needs a new patch.",
            "protocol": "Connect gate only; see GATEWAY_PROTOCOL_VERSION.",
        },
        "surfaces": {
            "defaultShip": default_ship,
            "continuous": continuous,
            "storeOptIn": store_opt_in,
            "matrix": matrix,
        },
        "secrets": secrets.groups,
        "publishCommand": format!(
            "cargo xtask release publish --version {next} --issue N --surfaces {}",
            default_ship.join(",")
        ),
        "note": "Maintainer must explicitly authorize publish. Prepare ≠ publish (D1). Never bump version only to fix a failed build (retry same tag / surface rebuild).",
    });

    if fs::create_dir_all(root.join("artifacts")).is_ok() {
        let _ = fs::write(
            root.join("artifacts/release-prepare.json"),
            format!("{}\n", serde_json::to_string_pretty(&report)?),
        );
    }
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(Some(report))
}

pub struct PublishArgs {
    pub version: String,
    pub issue: String,
    pub surfaces: Option<Vec<String>>,
    pub dry_run: bool,
    pub beta: bool,
    pub beta_n: String,
    pub push: bool,
}

pub fn run_publish(root: &Path, args: &PublishArgs) -> Result<Option<Value>> {
    if !is_strict_semver(&args.version) {
        eprintln!(
            "usage: cargo xtask release publish --version X.Y.Z --issue N [--surfaces a,b] [--beta] [--dry-run] [--push]"
        );
        return Ok(None);
    }
    let issue_ok = !args.issue.is_empty()
        && args.issue.bytes().all(|b| b.is_ascii_digit())
        && args.issue.bytes().any(|b| matches!(b, b'1'..=b'9'));
    if !issue_ok {
        eprintln!("publish requires --issue N (real GitHub issue; #0 is forbidden)");
        return Ok(None);
    }
    let beta_n: u64 = if args.beta {
        match args.beta_n.parse::<u64>() {
            Ok(n) if (1..=MAX_SAFE_INT).contains(&n) => n,
            _ => {
                eprintln!("publish requires --beta-n to be a positive safe integer");
                return Ok(None);
            }
        }
    } else {
        1
    };

    let resolved_ship = args
        .surfaces
        .clone()
        .unwrap_or_else(default_ship_surface_ids);
    if let Err(err) = resolve_ship_surfaces(&resolved_ship) {
        eprintln!("{err}");
        return Ok(None);
    }

    let root_pkg: Value = serde_json::from_str(
        &fs::read_to_string(root.join("package.json")).context("read package.json")?,
    )?;
    let prev = root_pkg
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let tag = if args.beta {
        format!("v{}-beta.{beta_n}", args.version)
    } else {
        format!("v{}", args.version)
    };
    let ship_manifest = json!({
        "version": args.version,
        "tag": tag,
        "issue": format!("#{}", args.issue),
        "surfaces": resolved_ship,
        "matrix": build_surface_matrix(Some(resolved_ship.clone())),
        "createdAt": format_iso_utc(now_epoch_ms()),
        "note": "Monorepo stamps all packages; ship set is intent for which workflows must go green.",
    });

    eprintln!(
        "publish {prev} → {} tag {tag} (#{}) surfaces=[{}]{}",
        args.version,
        args.issue,
        resolved_ship.join(","),
        if args.dry_run { " (dry-run)" } else { "" }
    );

    let sync_report = run_sync_versions(root, Some(&args.version), args.dry_run)?;
    let body = commits_since_last_tag(root)
        .map(|c| release_notes(&c, &args.version).trim().to_owned())
        .unwrap_or_else(|_| format!("Centraid {}", args.version));
    let body_path = root.join("artifacts/release-body.md");
    let ship_path = root.join("artifacts/release-ship.json");

    if !args.dry_run
        && let Some(parent) = body_path.parent()
        && fs::create_dir_all(parent).is_ok()
    {
        let _ = fs::write(&body_path, format!("{body}\n"));
        let _ = fs::write(
            &ship_path,
            format!("{}\n", serde_json::to_string_pretty(&ship_manifest)?),
        );
    }

    if args.dry_run {
        let preview: String = body.chars().take(200).collect();
        let mut out = json!({
            "version": args.version,
            "tag": tag,
            "prev": prev,
            "issue": args.issue,
            "surfaces": resolved_ship,
            "shipManifest": ship_manifest,
            "syncReport": sync_report,
            "bodyPath": body_path.display().to_string(),
            "bodyPreview": preview,
        });
        if resolved_ship.iter().any(|s| s == "mobile")
            && let Some(obj) = out.as_object_mut()
        {
            obj.insert(
                "mobileHint".to_owned(),
                Value::String(
                    "gh workflow run release.yml -f surfaces=mobile -f mobile_profile=preview -f mobile_platform=all -f mobile_submit=false".to_owned(),
                ),
            );
        }
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(Some(out));
    }

    let run_git = |git_args: &[String]| -> Result<()> {
        let status = Command::new("git")
            .args(git_args)
            .current_dir(root)
            .status()
            .with_context(|| format!("git {}", git_args.join(" ")))?;
        if !status.success() {
            bail!("git {} exited with {status}", git_args.join(" "));
        }
        Ok(())
    };

    let mut add_args = vec!["add".to_owned(), "--".to_owned()];
    add_args.extend(sync_report.workspaces.iter().cloned());
    run_git(&add_args)?;
    run_git(&[
        "commit".to_owned(),
        "-m".to_owned(),
        format!("chore(release): {} (#{})", args.version, args.issue),
    ])?;
    run_git(&[
        "tag".to_owned(),
        "-a".to_owned(),
        tag.clone(),
        "-m".to_owned(),
        format!("Centraid {tag}"),
    ])?;

    if args.push {
        run_git(&["push".to_owned(), "origin".to_owned(), "HEAD".to_owned()])?;
        run_git(&["push".to_owned(), "origin".to_owned(), tag.clone()])?;
    } else {
        eprintln!(
            "tag {tag} created locally. Push with: git push origin HEAD && git push origin {tag}"
        );
    }

    if resolved_ship.iter().any(|s| s == "mobile") {
        eprintln!(
            "mobile is in the ship set — after tag push, dispatch:\n  gh workflow run release.yml -f surfaces=mobile -f mobile_profile=preview -f mobile_platform=all -f mobile_submit=false"
        );
    }

    let out = json!({
        "version": args.version,
        "tag": tag,
        "issue": args.issue,
        "surfaces": resolved_ship,
        "bodyPath": body_path.display().to_string(),
        "shipPath": ship_path.display().to_string(),
        "build": sync_report.build,
    });
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_VERSION: &str = "0.4.2";
    const REPO_POINTING_GIT_VARS: [&str; 7] = [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_PREFIX",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ];

    fn git_isolated(cwd: &Path, args: &[&str]) -> std::process::Output {
        let mut cmd = Command::new("git");
        for key in REPO_POINTING_GIT_VARS {
            cmd.env_remove(key);
        }
        cmd.args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
            .env("GIT_COMMITTER_NAME", "fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
            .output()
            .expect("run git")
    }

    fn make_fixture_repo(subjects: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(
            dir.path().join("package.json"),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&json!({
                    "name": "release-fixture",
                    "version": FIXTURE_VERSION,
                }))
                .expect("json")
            ),
        )
        .expect("write package.json");
        assert!(git_isolated(dir.path(), &["init", "-q"]).status.success());
        assert!(git_isolated(dir.path(), &["add", "."]).status.success());
        for subject in subjects {
            assert!(
                git_isolated(
                    dir.path(),
                    &["commit", "-q", "--allow-empty", "-m", subject]
                )
                .status
                .success()
            );
        }
        dir
    }

    fn publish_args(version: &str, issue: &str) -> PublishArgs {
        PublishArgs {
            version: version.to_owned(),
            issue: issue.to_owned(),
            surfaces: None,
            dry_run: true,
            beta: false,
            beta_n: "1".to_owned(),
            push: false,
        }
    }

    #[test]
    fn sync_versions_stamps_only_matching_workspaces_and_honours_dry_run() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        fs::write(
            root.join("package.json"),
            r#"{"name":"centraid","version":"0.1.0"}"#,
        )
        .expect("write");
        fs::create_dir_all(root.join("desktop/electron")).expect("mkdir");
        fs::write(
            root.join("desktop/electron/package.json"),
            r#"{"name":"@centraid/desktop","version":"0.1.0"}"#,
        )
        .expect("write");
        fs::create_dir_all(root.join("packages/pinned")).expect("mkdir");
        fs::write(
            root.join("packages/pinned/package.json"),
            r#"{"name":"@centraid/pinned","version":"9.9.9"}"#,
        )
        .expect("write");

        run_sync_versions(root, Some("0.2.1"), true).expect("dry-run");
        let untouched: Value =
            serde_json::from_str(&fs::read_to_string(root.join("package.json")).expect("read"))
                .expect("json");
        assert_eq!(untouched["version"], "0.1.0");

        let report = run_sync_versions(root, Some("0.2.1"), false).expect("sync");
        assert_eq!(report.version, "0.2.1");
        assert_eq!(report.build, 2001);
        assert_eq!(
            report.workspaces,
            vec!["package.json", "desktop/electron/package.json"]
        );
        let desktop: Value = serde_json::from_str(
            &fs::read_to_string(root.join("desktop/electron/package.json")).expect("read"),
        )
        .expect("json");
        assert_eq!(desktop["version"], "0.2.1");
        let pinned: Value = serde_json::from_str(
            &fs::read_to_string(root.join("packages/pinned/package.json")).expect("read"),
        )
        .expect("json");
        assert_eq!(pinned["version"], "9.9.9");

        assert!(run_sync_versions(root, Some("v1"), false).is_err());
    }

    #[test]
    fn restamp_release_date_rewrites_appends_and_rejects_negative() {
        // 2026-07-22T12:00:00.000Z in epoch ms
        let now_ms: i64 = 1_784_721_600_000;
        assert_eq!(format_iso_utc(now_ms), "2026-07-22T12:00:00.000Z");

        let yml = "version: 0.2.0\npath: x.zip\nreleaseDate: '2026-07-22T12:00:00.000Z'\n";
        let (text, date) = restamp_release_date(yml, 72.0, now_ms).expect("restamp");
        assert_eq!(date, "2026-07-19T12:00:00.000Z");
        assert!(text.contains("releaseDate: '2026-07-19T12:00:00.000Z'"));
        assert!(text.contains("version: 0.2.0"));

        let missing = "version: 0.2.0\npath: x.zip\n";
        let (text2, date2) = restamp_release_date(missing, 0.0, now_ms).expect("append");
        assert_eq!(date2, "2026-07-22T12:00:00.000Z");
        assert!(text2.contains("releaseDate: '2026-07-22T12:00:00.000Z'"));

        assert!(restamp_release_date("version: 1\n", -1.0, now_ms).is_err());
    }

    #[test]
    fn publish_guards_refuse_bad_inputs_and_derive_dry_run_manifest() {
        let dir = make_fixture_repo(&["fix(a): x (#1)", "feat(b): a feature (#2)"]);
        let root = dir.path();

        assert!(
            run_publish(root, &publish_args("0.5", "656"))
                .expect("ok")
                .is_none()
        );
        assert!(
            run_publish(root, &publish_args("0.5.0", ""))
                .expect("ok")
                .is_none()
        );
        assert!(
            run_publish(root, &publish_args("0.5.0", "0"))
                .expect("ok")
                .is_none()
        );
        assert!(
            run_publish(root, &publish_args("0.5.0", "GH-656"))
                .expect("ok")
                .is_none()
        );

        let mut bad_surface = publish_args("0.5.0", "656");
        bad_surface.surfaces = Some(vec!["gateway-image".into(), "teleporter".into()]);
        assert!(run_publish(root, &bad_surface).expect("ok").is_none());

        for bad_beta in ["0", "-1", "1.5", "NaN", "9007199254740992"] {
            let mut a = publish_args("0.5.0", "656");
            a.beta = true;
            a.beta_n = bad_beta.to_owned();
            assert!(run_publish(root, &a).expect("ok").is_none(), "{bad_beta}");
        }

        let report = run_publish(root, &publish_args("1.2.3", "656"))
            .expect("ok")
            .expect("some");
        assert_eq!(report["tag"], "v1.2.3");
        assert_eq!(report["prev"], FIXTURE_VERSION);
        assert_eq!(report["syncReport"]["build"], 1_002_003);
        assert_eq!(
            report["surfaces"],
            json!(["gateway-image", "prebuilt-core"])
        );
        assert!(
            report["bodyPreview"]
                .as_str()
                .expect("str")
                .contains("- **b**: a feature (#2)")
        );

        let mut beta = publish_args("0.5.0", "656");
        beta.beta = true;
        beta.beta_n = "3".to_owned();
        let beta_report = run_publish(root, &beta).expect("ok").expect("some");
        assert_eq!(beta_report["tag"], "v0.5.0-beta.3");

        // Dry run leaves package.json untouched.
        let pkg: Value =
            serde_json::from_str(&fs::read_to_string(root.join("package.json")).expect("read"))
                .expect("json");
        assert_eq!(pkg["version"], FIXTURE_VERSION);
    }

    #[test]
    fn prepare_guards_check_candidate_dirty_and_bump_classification() {
        let dir = make_fixture_repo(&["fix(release): a fix (#1)"]);
        let root = dir.path();

        // Refuses unpromoted HEAD without override.
        assert!(
            run_prepare(root, true, true, false, None)
                .expect("ok")
                .is_none()
        );

        // Patch bump with override.
        let patch = run_prepare(root, true, true, true, Some("fixture"))
            .expect("ok")
            .expect("some");
        assert_eq!(patch["bump"], "patch");
        assert_eq!(patch["current"], FIXTURE_VERSION);
        assert_eq!(patch["next"], "0.4.3");
        assert_eq!(
            patch["publishCommand"],
            "cargo xtask release publish --version 0.4.3 --issue N --surfaces gateway-image,prebuilt-core"
        );

        // Dirty tree refused when allow_dirty is false.
        fs::write(root.join("untracked.txt"), "dirty\n").expect("write");
        assert!(
            run_prepare(root, false, true, true, Some("fixture"))
                .expect("ok")
                .is_none()
        );

        // Minor bump when a feat commit is present.
        let dir2 = make_fixture_repo(&["fix(a): x (#1)", "feat(b): a feature (#2)"]);
        let minor = run_prepare(dir2.path(), true, true, true, Some("fixture"))
            .expect("ok")
            .expect("some");
        assert_eq!(minor["bump"], "minor");
        assert_eq!(minor["next"], "0.5.0");

        // Refuses when no commit is releasable.
        let dir3 = make_fixture_repo(&["chore(release): 0.4.2 (#9)"]);
        assert!(
            run_prepare(dir3.path(), true, true, true, Some("fixture"))
                .expect("ok")
                .is_none()
        );
    }
}
