//! THE SHARE-IN INBOX (app-plane §10, D2, N8). The share extension and the Android receiver write
//! files only; they never open the vault. The app files each item on the next open through the
//! mapping below, with `arrived_via`, then deletes it. Draining is idempotent by uuid.
//!
//! | Inbox item | Becomes | `arrived_via` |
//! |---|---|---|
//! | `text`, `url` | a note (`note.import`, one Markdown file) | `share` |
//! | An image or video | a photo (`photo.add`) | `share` |
//! | A PDF or any other file | a document (`document.add`) | `share` |
//! | `.vcf` | people (`person.import_vcf`) | `vcard` |
//! | `.csv` that names people's columns | people (`person.import_csv`) | `csv` |
//! | `.csv` of anything else, `.ics` | kept in the inbox: Money's column mapping and the events importer are the apps' own milestones | |
//!
//! Idempotence has two layers. A photo or document is filed under the item's own uuid as its
//! entity id when the extension minted a UUIDv7 (the vault refuses a second row under one id, and
//! the drain asks first), a note by the vault's own same-title-same-words skip, a vCard or CSV by
//! the import's own merge. A drained uuid is also written to `drained.json` before its folder is
//! deleted, so a crash between the two costs a folder deleted on the next open, never a copy.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};

const MANIFEST: &str = "manifest.json";
const PAYLOAD: &str = "payload";
const LEDGER: &str = "drained.json";
const LEDGER_MOST: usize = 500;
const TITLE_MOST: usize = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Type {
    File,
    Text,
    Url,
}

/// `manifest.json`, version 1.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Manifest {
    pub v: u32,
    #[serde(rename = "type")]
    pub kind: Type,
    #[serde(default)]
    pub uti_or_mime: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub from_app: String,
    #[serde(default)]
    pub received_at: i64,
}

#[derive(Debug, Clone)]
pub struct Item {
    pub uuid: String,
    pub dir: PathBuf,
    pub manifest: Manifest,
}

/// Where an item goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Note,
    Photo,
    Document,
    Vcard,
    CsvPeople,
    /// Left in the inbox, and why.
    Later(&'static str),
}

/// What became of one item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fate {
    Filed(Route),
    /// Already drained: its folder is deleted.
    Already,
    Kept(String),
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    pub items: Vec<(String, Fate)>,
}

impl Report {
    #[must_use]
    pub fn filed(&self) -> usize {
        self.items
            .iter()
            .filter(|(_, fate)| matches!(fate, Fate::Filed(_)))
            .count()
    }

    #[must_use]
    pub fn kept(&self) -> usize {
        self.items
            .iter()
            .filter(|(_, fate)| matches!(fate, Fate::Kept(_)))
            .count()
    }
}

/// What filing needs of the core.
pub trait Filer {
    /// Run one vault command, once under `invoke_key`.
    ///
    /// # Errors
    /// The command's refusal in words.
    fn command(&self, name: &str, input: &Value, invoke_key: &str) -> Result<Value, String>;

    /// Stage `path`'s bytes and answer their content hash.
    ///
    /// # Errors
    /// The stage door's refusal in words.
    fn stage(&self, path: &Path, media_type: &str) -> Result<String, String>;

    /// Whether an entity with `id` exists, trashed or not.
    ///
    /// # Errors
    /// The read's failure.
    fn exists(&self, id: &str) -> Result<bool, String>;
}

/// The items waiting, oldest first. A folder whose manifest does not read is not an item.
#[must_use]
pub fn list(inbox: &Path) -> Vec<Item> {
    let Ok(read) = std::fs::read_dir(inbox) else {
        return Vec::new();
    };
    let mut items: Vec<Item> = read
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let uuid = entry.file_name().into_string().ok()?;
            let text = std::fs::read_to_string(entry.path().join(MANIFEST)).ok()?;
            let manifest: Manifest = serde_json::from_str(&text).ok()?;
            (manifest.v == 1).then(|| Item {
                uuid,
                dir: entry.path(),
                manifest,
            })
        })
        .collect();
    items.sort_by(|a, b| (a.manifest.received_at, &a.uuid).cmp(&(b.manifest.received_at, &b.uuid)));
    items
}

fn extension(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default()
}

/// The route an item takes. `head` is the first bytes of its payload, for a CSV's header.
#[must_use]
pub fn route(manifest: &Manifest, head: &[u8]) -> Route {
    if manifest.kind != Type::File {
        return Route::Note;
    }
    let ext = extension(&manifest.name);
    let mime = manifest.uti_or_mime.to_ascii_lowercase();
    if ext == "vcf" || mime.contains("vcard") {
        return Route::Vcard;
    }
    if ext == "ics" || mime.contains("calendar") {
        return Route::Later("events come in with the Calendar milestone");
    }
    if ext == "csv" || mime.contains("csv") || mime.contains("comma-separated") {
        let header = String::from_utf8_lossy(head)
            .lines()
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let names_people = ["name", "email", "phone"]
            .iter()
            .any(|column| header.contains(column))
            && !header.contains("amount");
        return if names_people {
            Route::CsvPeople
        } else {
            Route::Later("a spreadsheet of money or Locker items needs its column mapping")
        };
    }
    if mime.starts_with("image/")
        || mime.starts_with("video/")
        || mime.contains("public.image")
        || mime.contains("public.movie")
        || matches!(
            ext.as_str(),
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "heic" | "mov" | "mp4"
        )
    {
        return Route::Photo;
    }
    Route::Document
}

fn media_type(manifest: &Manifest) -> String {
    let mime = manifest.uti_or_mime.to_ascii_lowercase();
    if mime.contains('/') && !mime.starts_with("public.") {
        return mime;
    }
    match extension(&manifest.name).as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "mov" => "video/quicktime",
        "mp4" => "video/mp4",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
    .to_owned()
}

fn label(manifest: &Manifest, from: &str) -> String {
    let name = manifest.name.trim();
    if name.is_empty() {
        from.to_owned()
    } else {
        name.to_owned()
    }
}

fn title_of(text: &str, name: &str) -> String {
    let first = text
        .lines()
        .map(|line| line.trim().trim_start_matches('#').trim())
        .find(|line| !line.is_empty())
        .unwrap_or(name);
    let cut: String = first.chars().take(TITLE_MOST).collect();
    if cut.is_empty() {
        "Shared".to_owned()
    } else {
        cut
    }
}

fn is_minted_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(at, byte)| match at {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => *byte == b'7',
            19 => matches!(byte, b'8'..=b'b'),
            _ => matches!(byte, b'0'..=b'9' | b'a'..=b'f'),
        })
}

fn drained(inbox: &Path) -> Vec<String> {
    std::fs::read_to_string(inbox.join(LEDGER))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            value.get("uuids").and_then(Value::as_array).map(|list| {
                list.iter()
                    .filter_map(|id| id.as_str().map(str::to_owned))
                    .collect()
            })
        })
        .unwrap_or_default()
}

fn remember(inbox: &Path, uuid: &str) -> Result<(), String> {
    let mut seen = drained(inbox);
    if !seen.iter().any(|id| id == uuid) {
        seen.push(uuid.to_owned());
    }
    let from = seen.len().saturating_sub(LEDGER_MOST);
    let record = json!({ "v": 1, "uuids": &seen[from..] });
    let file = inbox.join(LEDGER);
    let temp = file.with_extension("tmp");
    std::fs::write(&temp, record.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &file).map_err(|e| e.to_string())
}

fn file_item(item: &Item, route: Route, filer: &dyn Filer) -> Result<(), String> {
    let payload = item.dir.join(PAYLOAD);
    let manifest = &item.manifest;
    let key = format!("share-in:{}", item.uuid);
    let named = label(manifest, &item.uuid);
    match route {
        Route::Note => {
            let raw = std::fs::read_to_string(&payload).map_err(|e| e.to_string())?;
            let body = raw.trim();
            let title = title_of(body, "Shared");
            let text = if body.starts_with('#') || manifest.kind == Type::Url {
                body.to_owned()
            } else {
                format!("# {title}\n\n{body}")
            };
            filer.command(
                "note.import",
                &json!({
                    "files": [{ "path": format!("{title}.md"), "text": text }],
                    "arrived_via": "share",
                    "arrived_label": if manifest.from_app.is_empty() { named } else { manifest.from_app.clone() },
                }),
                &key,
            )?;
        }
        Route::Photo | Route::Document => {
            let media = media_type(manifest);
            let id = is_minted_id(&item.uuid).then(|| item.uuid.clone());
            if let Some(id) = &id
                && filer.exists(id)?
            {
                return Ok(());
            }
            let blob = filer.stage(&payload, &media)?;
            let mut input = json!({
                "blob": blob,
                "media_type": media,
                "arrived_via": "share",
                "arrived_label": named,
            });
            if let Some(id) = id {
                input["id"] = Value::String(id);
            }
            if route == Route::Photo {
                filer.command("photo.add", &input, &key)?;
            } else {
                input["title"] = Value::String(
                    Path::new(&named)
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .unwrap_or("Shared")
                        .to_owned(),
                );
                filer.command("document.add", &input, &key)?;
            }
        }
        Route::Vcard => {
            let cards = std::fs::read_to_string(&payload).map_err(|e| e.to_string())?;
            filer.command(
                "person.import_vcf",
                &json!({ "cards": cards, "arrived_via": "vcard", "arrived_label": named }),
                &key,
            )?;
        }
        Route::CsvPeople => {
            let csv = std::fs::read_to_string(&payload).map_err(|e| e.to_string())?;
            filer.command(
                "person.import_csv",
                &json!({ "csv": csv, "arrived_via": "csv", "arrived_label": named }),
                &key,
            )?;
        }
        Route::Later(_) => {}
    }
    Ok(())
}

/// File every item in `inbox` and delete what was filed.
pub fn drain(inbox: &Path, filer: &dyn Filer) -> Report {
    let seen = drained(inbox);
    let mut report = Report::default();
    for item in list(inbox) {
        let uuid = item.uuid.clone();
        if seen.contains(&uuid) {
            let _ = std::fs::remove_dir_all(&item.dir);
            report.items.push((uuid, Fate::Already));
            continue;
        }
        let head = read_head(&item.dir.join(PAYLOAD));
        let route = route(&item.manifest, &head);
        if let Route::Later(why) = route {
            report.items.push((uuid, Fate::Kept(why.to_owned())));
            continue;
        }
        match file_item(&item, route, filer) {
            Ok(()) => {
                let tidy = remember(inbox, &uuid)
                    .and_then(|()| std::fs::remove_dir_all(&item.dir).map_err(|e| e.to_string()));
                match tidy {
                    Ok(()) => report.items.push((uuid, Fate::Filed(route))),
                    Err(why) => report.items.push((uuid, Fate::Kept(why))),
                }
            }
            Err(why) => report.items.push((uuid, Fate::Kept(why))),
        }
    }
    report
}

fn read_head(payload: &Path) -> Vec<u8> {
    use std::io::Read as _;
    let mut head = vec![0_u8; 512];
    let Ok(mut file) = std::fs::File::open(payload) else {
        return Vec::new();
    };
    let read = file.read(&mut head).unwrap_or(0);
    head.truncate(read);
    head
}

const CHUNK: usize = 64 * 1024;

/// The core as the drain's filer: commands through its one write path, bytes through the stage
/// door in 64 KiB frames, existence from one read of `entity`.
pub struct CoreFiler<'a>(pub &'a crate::Handle);

impl Filer for CoreFiler<'_> {
    fn command(&self, name: &str, input: &Value, invoke_key: &str) -> Result<Value, String> {
        self.0
            .command(name, input, invoke_key)
            .map(|outcome| outcome.output)
            .map_err(|error| error.to_string())
    }

    fn stage(&self, path: &Path, media_type: &str) -> Result<String, String> {
        use centraid_api_proto::core_v1 as wire;
        use std::io::Read as _;
        let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
        let call = |kind: wire::stage_request::Kind| {
            self.0
                .call(&wire::Request {
                    kind: Some(wire::request::Kind::Stage(wire::StageRequest {
                        kind: Some(kind),
                    })),
                })
                .map_err(|error| error.to_string())
        };
        let answer = |response: wire::Response| match response.kind {
            Some(wire::response::Kind::Stage(stage)) => Ok(stage),
            _ => Err("the stage door answered something else".to_owned()),
        };
        let begun = answer(call(wire::stage_request::Kind::Begin(wire::StageBegin {
            media_type: media_type.to_owned(),
            byte_size: size,
            source: wire::StageSource::Owned as i32,
            ..wire::StageBegin::default()
        }))?)?;
        let Some(wire::stage_response::Kind::Begun(begun)) = begun.kind else {
            return Err("the stage door did not begin".to_owned());
        };
        let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut buffer = vec![0_u8; CHUNK];
        let mut seq = 0_u64;
        loop {
            let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            let sent = call(wire::stage_request::Kind::Chunk(wire::StageChunk {
                staging_id: begun.staging_id.clone(),
                seq,
                payload: buffer[..read].to_vec(),
            }));
            if let Err(why) = sent {
                let _ = call(wire::stage_request::Kind::Abort(wire::StageAbort {
                    staging_id: begun.staging_id.clone(),
                }));
                return Err(why);
            }
            seq += 1;
        }
        let ended = answer(call(wire::stage_request::Kind::End(wire::StageEnd {
            staging_id: begun.staging_id,
        }))?)?;
        match ended.kind {
            Some(wire::stage_response::Kind::Handle(handle)) => Ok(handle.content_hash),
            _ => Err("the stage door did not end".to_owned()),
        }
    }

    fn exists(&self, id: &str) -> Result<bool, String> {
        self.0
            .with_vault(|vault| {
                vault
                    .read(|connection| {
                        let held: i64 = connection.query_row(
                            "SELECT COUNT(*) FROM entity WHERE id = ?1",
                            [id],
                            |row| row.get(0),
                        )?;
                        Ok(held > 0)
                    })
                    .map_err(Into::into)
            })
            .map_err(|error| error.to_string())
    }
}
