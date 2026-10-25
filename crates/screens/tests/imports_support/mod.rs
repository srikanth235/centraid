//! A SHELL FOR THE PHONE IMPORTS: opens the three services and plays the platform's part of every
//! effect (the library, the keychain, the link, the folders) against a real vault and its real
//! stage door, so a case asserts on what the vault holds and on the effects Rust asked for.
#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};

use centraid_api_proto::core_v1 as wire;
use centraid_screens::imports;
use centraid_screens::testing::Driver;

pub struct Shell {
    pub d: Driver,
    pub roll: u64,
    pub files: u64,
    pub made: u64,
}

pub fn shell() -> Shell {
    shell_over(imports::runtime())
}

/// The same shell over a runtime of the test's own (the imports plus a stand-in for a screen
/// that listens to them).
pub fn shell_over(runtime: centraid_screens::Runtime) -> Shell {
    let mut d = Driver::with_runtime(runtime);
    d.start();
    let tabs = d.navigation.clone().expect("navigation").tabs;
    let at = |n: usize| tabs[n].entries[0].instance;
    Shell {
        roll: at(0),
        files: at(1),
        made: at(2),
        d,
    }
}

fn stage_frame(d: &Driver, kind: wire::stage_request::Kind) -> wire::stage_response::Kind {
    let answer = d
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Stage(wire::StageRequest {
                kind: Some(kind),
            })),
        })
        .expect("a stage frame");
    let Some(wire::response::Kind::Stage(stage)) = answer.kind else {
        panic!("a stage frame answers");
    };
    stage.kind.expect("a kind")
}

/// Stream `bytes` through the core's stage door under `begin`, as a shell does.
pub fn stage(d: &Driver, begin: wire::StageBegin, bytes: &[u8]) -> wire::StageHandle {
    let wire::stage_response::Kind::Begun(begun) =
        stage_frame(d, wire::stage_request::Kind::Begin(begin))
    else {
        panic!("begun");
    };
    let ceiling = usize::try_from(begun.chunk_bytes).expect("fits");
    for (seq, window) in bytes.chunks(ceiling).enumerate() {
        stage_frame(
            d,
            wire::stage_request::Kind::Chunk(wire::StageChunk {
                staging_id: begun.staging_id.clone(),
                seq: seq as u64,
                payload: window.to_vec(),
            }),
        );
    }
    let wire::stage_response::Kind::Handle(staged) = stage_frame(
        d,
        wire::stage_request::Kind::End(wire::StageEnd {
            staging_id: begun.staging_id,
        }),
    ) else {
        panic!("a handle");
    };
    staged
}

pub fn owned(media_type: &str, bytes: &[u8]) -> wire::StageBegin {
    wire::StageBegin {
        media_type: media_type.to_owned(),
        byte_size: bytes.len() as u64,
        source: wire::StageSource::Owned as i32,
        ..wire::StageBegin::default()
    }
}

fn unhex(hash: &str) -> Vec<u8> {
    (0..hash.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&hash[at..at + 2], 16).expect("hex"))
        .collect()
}

// ---------------------------------------------------------------------------
// The photo library, as the platform holds it
// ---------------------------------------------------------------------------

pub fn wifi() -> wire::LinkReading {
    wire::LinkReading {
        online: true,
        metered: false,
        platform_refused: false,
        rule: wire::link_reading::Rule::WifiOnly as i32,
    }
}

pub fn photo(id: &str) -> wire::RollAsset {
    wire::RollAsset {
        after: id.to_owned(),
        kind: wire::roll_asset::Kind::Photo as i32,
        captured_at: "2026-02-03T10:11:12Z".to_owned(),
        resources: vec![resource(id, wire::roll_resource::Role::Original)],
        ..wire::RollAsset::default()
    }
}

pub fn live(id: &str) -> wire::RollAsset {
    let mut asset = photo(id);
    asset.capture_group = id.to_owned();
    asset.resources.push(resource(
        &format!("{id}#pairedVideo"),
        wire::roll_resource::Role::PairedVideo,
    ));
    asset
}

pub fn resource(reference: &str, role: wire::roll_resource::Role) -> wire::RollResource {
    wire::RollResource {
        r#ref: reference.to_owned(),
        role: role as i32,
    }
}

/// What the platform's photo library and keychain hold, and what was asked of them.
pub struct Library {
    pub permission: wire::PhotosMediaPermission,
    /// What the prompt answers when it is shown.
    pub prompt_grants: wire::PhotosMediaPermission,
    pub assets: Vec<wire::RollAsset>,
    pub bytes: BTreeMap<String, Vec<u8>>,
    pub in_cloud: BTreeSet<String>,
    pub link: wire::LinkReading,
    pub keychain: BTreeMap<String, String>,
    /// `(ref, allow_network)` per stage asked.
    pub asked: Vec<(String, bool)>,
    /// `(ref, tier)` per derivative rendered and staged.
    pub rendered: Vec<(String, String)>,
    /// What each stage came to, for the case to read: `(ref, handle)`.
    pub staged: Vec<(String, wire::StageHandle)>,
    pub pages: Vec<(String, u32)>,
    pub prompts: u32,
    /// Say the vault holds these derivative tiers whatever the core answered (a restored phone).
    pub derivatives_held: Option<Vec<String>>,
}

impl Library {
    pub fn new() -> Self {
        Self {
            permission: wire::PhotosMediaPermission::Granted,
            prompt_grants: wire::PhotosMediaPermission::Granted,
            assets: Vec::new(),
            bytes: BTreeMap::new(),
            in_cloud: BTreeSet::new(),
            link: wifi(),
            keychain: BTreeMap::new(),
            asked: Vec::new(),
            rendered: Vec::new(),
            staged: Vec::new(),
            pages: Vec::new(),
            prompts: 0,
            derivatives_held: None,
        }
    }

    pub fn with(mut self, asset: wire::RollAsset, bytes: &[(&str, &[u8])]) -> Self {
        self.assets.push(asset);
        for (reference, content) in bytes {
            self.bytes.insert((*reference).to_owned(), content.to_vec());
        }
        self
    }
}

/// Answer every pending effect of the camera roll the way the platform would, until none is left.
pub fn serve_library(shell: &mut Shell, library: &mut Library) {
    use wire::effect::Kind as K;
    use wire::effect_result::Outcome as O;
    while let Some(request) = shell.d.effects.first().cloned() {
        let Some(kind) = request.effect.and_then(|effect| effect.kind) else {
            shell.d.effects.remove(0);
            continue;
        };
        let outcome = match kind {
            K::LibraryPermission(asked) => {
                if asked.ask {
                    library.prompts += 1;
                    library.permission = library.prompt_grants;
                }
                O::LibraryPermissionRead(wire::LibraryPermissionRead {
                    permission: library.permission as i32,
                })
            }
            K::Keychain(op) => match wire::keychain_op::Op::try_from(op.op).unwrap() {
                wire::keychain_op::Op::Set => {
                    library
                        .keychain
                        .insert(op.key, String::from_utf8(op.value).unwrap());
                    O::Done(wire::EffectDone {})
                }
                _ => match library.keychain.get(&op.key) {
                    Some(value) => O::Keychain(wire::KeychainValue {
                        found: true,
                        value: value.clone().into_bytes(),
                    }),
                    None => O::Keychain(wire::KeychainValue::default()),
                },
            },
            K::RollPage(page) => {
                library.pages.push((page.cursor.clone(), page.limit));
                let from = if page.cursor.is_empty() {
                    0
                } else {
                    library
                        .assets
                        .iter()
                        .position(|asset| asset.after == page.cursor)
                        .map_or(library.assets.len(), |at| at + 1)
                };
                let rest = &library.assets[from..];
                let take = rest.len().min(page.limit as usize);
                let assets = rest[..take].to_vec();
                let exhausted = take == rest.len();
                O::RollPaged(wire::RollPaged {
                    next_cursor: assets.last().map(|a| a.after.clone()).unwrap_or_default(),
                    assets,
                    exhausted,
                })
            }
            K::LinkRead(_) => O::LinkReading(library.link),
            K::LibraryStage(stage_ask) => {
                library
                    .asked
                    .push((stage_ask.r#ref.clone(), stage_ask.allow_network));
                O::LibraryStaged(stage_library(&shell.d, library, &stage_ask))
            }
            K::LibraryDerivatives(derivatives) => {
                for tier in &derivatives.tiers {
                    let content = format!("{tier}:{}", derivatives.r#ref).into_bytes();
                    let begin = wire::StageBegin {
                        media_type: "image/jpeg".to_owned(),
                        byte_size: content.len() as u64,
                        source: wire::StageSource::Owned as i32,
                        for_hash: unhex(&derivatives.for_hash),
                        tier: tier.clone(),
                        ..wire::StageBegin::default()
                    };
                    stage(&shell.d, begin, &content);
                    library
                        .rendered
                        .push((derivatives.r#ref.clone(), tier.clone()));
                }
                O::Done(wire::EffectDone {})
            }
            other => panic!("the camera roll asked for {other:?}"),
        };
        shell.d.answer_effect(outcome);
    }
}

fn stage_library(
    d: &Driver,
    library: &mut Library,
    ask: &wire::LibraryStage,
) -> wire::LibraryStaged {
    use wire::library_staged::Outcome as O;
    if library.in_cloud.contains(&ask.r#ref) && !ask.allow_network {
        return wire::LibraryStaged {
            outcome: O::InCloud as i32,
            ..wire::LibraryStaged::default()
        };
    }
    let Some(content) = library.bytes.get(&ask.r#ref).cloned() else {
        return wire::LibraryStaged {
            outcome: O::Gone as i32,
            ..wire::LibraryStaged::default()
        };
    };
    let media_type = if ask.media_type.is_empty() {
        "image/jpeg".to_owned()
    } else {
        ask.media_type.clone()
    };
    let begin = wire::StageBegin {
        media_type: media_type.clone(),
        byte_size: 0,
        source: wire::StageSource::OsLibrary as i32,
        os_ref: ask.r#ref.clone(),
        ..wire::StageBegin::default()
    };
    let handle = stage(d, begin, &content);
    library.staged.push((ask.r#ref.clone(), handle.clone()));
    wire::LibraryStaged {
        outcome: O::Ready as i32,
        media_type,
        content_hash: handle.content_hash,
        byte_size: handle.byte_size,
        already_held: handle.already_held,
        derivatives_held: library
            .derivatives_held
            .clone()
            .unwrap_or(handle.derivatives_held),
        ..wire::LibraryStaged::default()
    }
}
