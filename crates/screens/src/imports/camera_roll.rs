//! `imports.camera_roll`: THE CAMERA ROLL, GOING IN (#1025 S6; #1080; #1135).
//!
//! The Rust form of the KMP `CameraRoll`, `CameraRollRunner`, `CameraRollSeat` and `LibraryFeed`:
//! the half of the product that turns a photograph on a phone into a row in a vault and a sealed
//! part in its spool.
//!
//! ```text
//!   RollPage(cursor) -> LibraryStage(ref) -> core names + seals -> add-photo -> LibraryDerivatives
//!   the shell lists    the shell streams     (the stage door)       THIS VAULT    the shell renders
//!                      the bytes                                    COMMITS       the tiers
//! ```
//!
//! **The phone never computes an identity**: the shell stages first, the core answers the hash,
//! and the `add-photo` it then commits NAMES that hash and the size the core counted. **No second
//! copy** (#1080 ruling 6): a resource is staged with `source = OS_LIBRARY` and its `os_ref`, and
//! the core keeps no plaintext copy. The shell does the streaming and the OS work; everything
//! below is decided here.
//!
//! ## What is decided here
//!
//! * **The grant** and its four sentences (never the member's fault); LIMITED is a library.
//! * **The cursor**: per vault (`camera-roll.cursor.<vault>`, in the keychain through
//!   `KeychainOp`), advanced after each asset so a pass the OS kills resumes where it was; the
//!   page's own cursor last, because on iOS it turns a finished walk into a change token.
//! * **The walk to the end**: pages of 25 follow each other while the last ended mid-roll, and a
//!   trigger during a walk queues exactly one more, after it (never a second reader of one cursor).
//! * **What may cross which link**: an original that lives only in iCloud is downloaded only when
//!   the member's rule lets it cross the link the phone is on ([`may_fetch`]); one that may not
//!   stops the walk with the cursor before it.
//! * **An edit comes in beside its original** (A20): the camera's bytes first, the render with the
//!   original's asset as `edited_from`; an item edited in place is compared with the version the
//!   vault holds (`prior_*`), and the same bytes are no edit at all. A Live Photo is a `photo` and
//!   a `video` in one capture group.
//! * **A re-walk renders nothing** and a restored phone's re-walk renders only the tiers the vault
//!   lacks (`derivatives_held`).
//! * **The invoke key is fresh per add**: the core remembers a key for good, and
//!   `add-photo` itself adopts the photograph that already holds the same bytes.
//!
//! The bytes the core asked for again (`DrainResponse.need_bytes`, the old `LibraryFeed`) are
//! served the same way: reopened by their `os_ref`, and only the hash asked for counts.
//!
//! ## What the shell does
//!
//! It forwards this screen's view to every open Photos home as `PhotosPermissionChanged` and
//! `PhotosBackupChanged` (and once when a home opens), relays Photos' `CameraRoll` effect as
//! `Requested`, sends `Walk` when the app opens or comes forward and `LibraryChanged` on a
//! `PHChange`, and moves what was staged (`ShelfDrain.afterImport`) whenever `imported_total` grows.

use std::collections::VecDeque;

use centraid_api_proto::core_v1 as wire;
use wire::imports_camera_roll_event::Kind as C;
use wire::screen_event::Kind as E;

use super::effect;
use crate::catalog::act;
use crate::field::{Field, Keyed};
use crate::kit::act as kit_act;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, imports as words, photos as photo_words};

use wire::PhotosMediaPermission as Permission;

/// One page, and one pass. Small because each item is an ORIGINAL: tens of megabytes, sometimes
/// hundreds, and a window will not finish more. The cursor makes a small page cost nothing.
pub const PAGE: u32 = 25;

/// A hundred thousand items at [`PAGE`], and never a loop.
const MAX_PASSES: u32 = 4_000;

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::Imports(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Roll::new(&args.vault_id)))
}

/// The keychain key of a vault's cursor. PER VAULT, because a photograph offered to two vaults is
/// two imports and two rows, so a device that holds two vaults walks the roll once for each.
#[must_use]
pub fn cursor_key(vault_id: &str) -> String {
    format!("camera-roll.cursor.{vault_id}")
}

/// Can the roll enumerate? LIMITED counts: a selection is a real library the member chose.
#[must_use]
pub fn can_enumerate(permission: Permission) -> bool {
    matches!(permission, Permission::Granted | Permission::Limited)
}

/// WHAT THE GRANT MEANS, IN WORDS, AND NEVER A MEMBER'S FAULT: the sentences Photos' home words.
#[must_use]
pub fn permission_sentence(locale: Locale, permission: Permission) -> String {
    match permission {
        Permission::Limited => photo_words::photos_permission_limited(locale),
        Permission::NotAsked => photo_words::photos_permission_not_asked(locale),
        Permission::Denied => photo_words::photos_permission_denied(locale),
        Permission::Restricted => photo_words::photos_permission_restricted(locale),
        Permission::Granted | Permission::Unspecified => String::new(),
    }
}

/// MAY THIS PASS DOWNLOAD AN ORIGINAL THAT LIVES ONLY IN iCLOUD? (#1080)
///
/// The member's one setting, against the platform's real answer. A refused platform reading counts
/// as expensive: a guess wrong towards cheap spends a data plan, a guess wrong towards expensive
/// delays a photograph. A video never crosses a metered link, whatever the rule, and under MANUAL
/// what a backup needs waits for Wi-Fi as under WIFI_ONLY (R-1080-D7).
#[must_use]
pub fn may_fetch(link: &wire::LinkReading, video: bool) -> bool {
    use wire::link_reading::Rule;
    if !link.online {
        return false;
    }
    if !(link.metered || link.platform_refused) {
        return true;
    }
    match Rule::try_from(link.rule).unwrap_or(Rule::Unspecified) {
        Rule::WifiAndCellularPhotos => !video,
        Rule::WifiOnly | Rule::Manual | Rule::Unspecified => false,
    }
}

/// `add-photo`'s request for one staged resource.
///
/// `edited_from` is the CORE'S asset id for edit lineage (#711), never the phone's local
/// identifier (a dangling foreign key wearing a field's name); the local reference travels on the
/// stage door as `os_ref`. `phash` is not sent (a duplicates hint a phone would decode every
/// original to produce). `size` is the bytes the core counted: the stage door only stores and
/// hashes, and a command claims the bytes it names.
#[must_use]
pub fn add_request(
    asset: &wire::RollAsset,
    hash: &str,
    size: u64,
    media_type: &str,
    video: bool,
    edited_from: Option<&str>,
) -> act::photos::Upload {
    use act::photos::UploadForm;
    let mut request = act::photos::Upload {
        blob: hash.to_owned(),
        media_type: media_type.to_owned(),
        size: Some(i64::try_from(size).unwrap_or(i64::MAX)),
        form: Some(if video {
            UploadForm::Video
        } else {
            UploadForm::Photo
        }),
        ..act::photos::Upload::default()
    };
    match edited_from {
        // AN EDIT SAYS NOTHING OF WHEN IT WAS TAKEN: the core fills the date, the zone, the
        // caption and the place in from the original it names, so a date the member corrected
        // there is kept (A20).
        Some(from) => request.edited_from = Field::Is(from.to_owned()),
        None => {
            if !asset.captured_at.is_empty() {
                request.taken_at = Field::Is(asset.captured_at.clone());
            }
            request.offset_min = Field::Is(i64::from(asset.captured_utc_offset_minutes));
        }
    }
    if !asset.capture_group.is_empty() {
        request.burst = Field::Is(asset.capture_group.clone());
    }
    request
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

/// What the screen waits on, so an answer that is not ours is ignored.
enum Wait {
    Nothing,
    /// The OS grant: why it was asked, and what follows.
    Permission(Why),
    Cursor,
    Page,
    Link,
    Stage,
    Derivatives,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Why {
    /// Read at start: a read, never an ask (R-PHOTOS-1).
    Sync,
    /// The member's tap: show the prompt, and walk if it allows.
    Ask,
    /// The head of a walk.
    Walk,
}

/// What one resource of an asset is, being offered.
struct Resource {
    reference: String,
    camera: bool,
    original: bool,
    video: bool,
}

/// One asset being offered: whole or not at all as far as the cursor is concerned.
struct Offer {
    asset: wire::RollAsset,
    todo: VecDeque<wire::RollResource>,
    current: Option<Resource>,
    /// The camera original's asset, once committed: the edit's lineage.
    camera_asset: Option<String>,
    camera_bytes: u64,
    queued: Option<(bool, u64)>,
    /// The assets still ahead of this one, this one included.
    left: usize,
    /// The staged answer waiting on its derivatives.
    staged: Option<wire::LibraryStaged>,
}

/// One walk: pages while the last ended mid-roll.
struct Walk {
    passes: u32,
    cursor: String,
    assets: VecDeque<wire::RollAsset>,
    next_cursor: String,
    exhausted: bool,
    enumerated: usize,
    queued: u32,
    held: u32,
    skipped: u32,
    moved: u64,
    offer: Option<Offer>,
    /// Photographs this walk brought in (not already held).
    imported: u32,
}

/// The bytes the core asked for again.
struct Feed {
    needs: VecDeque<wire::NeededBytes>,
    current: Option<wire::NeededBytes>,
    landed: u32,
}

enum Job {
    Walk(Box<Walk>),
    Feed(Feed),
}

struct Roll {
    vault_id: String,
    permission: Permission,
    backup: wire::PhotosBackupChanged,
    wait: Wait,
    job: Option<Job>,
    /// A trigger arrived during a job: exactly one more walk follows it.
    walk_queued: bool,
    /// Needs that arrived during a job.
    needs_queued: Vec<wire::NeededBytes>,
    imported_total: u32,
    fed_last_round: u32,
    fed_rounds: u32,
}

fn keychain(op: wire::keychain_op::Op, key: &str, value: &str) -> wire::Effect {
    effect(wire::effect::Kind::Keychain(wire::KeychainOp {
        op: op as i32,
        key: key.to_owned(),
        value: value.as_bytes().to_vec(),
    }))
}

impl Roll {
    fn new(vault_id: &str) -> Self {
        Self {
            vault_id: vault_id.to_owned(),
            permission: Permission::NotAsked,
            backup: wire::PhotosBackupChanged {
                phase: wire::PhotosBackupPhase::Idle as i32,
                ..wire::PhotosBackupChanged::default()
            },
            wait: Wait::Nothing,
            job: None,
            walk_queued: false,
            needs_queued: Vec::new(),
            imported_total: 0,
            fed_last_round: 0,
            fed_rounds: 0,
        }
    }

    fn publish(
        &mut self,
        phase: wire::PhotosBackupPhase,
        transferred: u32,
        remaining: usize,
        reason: String,
    ) {
        self.backup = wire::PhotosBackupChanged {
            phase: phase as i32,
            assets_transferred_this_session: transferred,
            assets_remaining: u32::try_from(remaining).unwrap_or(u32::MAX),
            paused_reason: reason,
        };
    }

    fn ask_permission(&mut self, ask: bool, why: Why) -> Vec<wire::Effect> {
        self.wait = Wait::Permission(why);
        vec![effect(wire::effect::Kind::LibraryPermission(
            wire::LibraryPermission { ask },
        ))]
    }

    /// A trigger to walk the roll to its end: now when nothing runs, else exactly one more after.
    fn trigger(&mut self) -> Vec<wire::Effect> {
        if self.job.is_some() {
            self.walk_queued = true;
            return Vec::new();
        }
        self.job = Some(Job::Walk(Box::new(Walk {
            passes: 0,
            cursor: String::new(),
            assets: VecDeque::new(),
            next_cursor: String::new(),
            exhausted: false,
            enumerated: 0,
            queued: 0,
            held: 0,
            skipped: 0,
            moved: 0,
            offer: None,
            imported: 0,
        })));
        self.ask_permission(false, Why::Walk)
    }

    /// The job is over, however it ended: what queued behind it goes.
    fn end(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        self.wait = Wait::Nothing;
        if let Some(Job::Walk(walk)) = self.job.take() {
            self.imported_total += walk.imported;
            // THE PASS WAITS ON THE ROLL, so a walk that ends tells it however it ended (a
            // denied grant, a refused effect, the end of the roll). A walk queued behind this
            // one reports at its own end: the pass asked for the roll as it is now.
            if !self.walk_queued {
                Self::report(
                    ctx,
                    wire::roll_reported::Kind::Walked(wire::roll_reported::WalkEnded {}),
                );
            }
        }
        if !self.needs_queued.is_empty() {
            let needs = std::mem::take(&mut self.needs_queued);
            return self.feed(ctx, needs);
        }
        if self.walk_queued {
            self.walk_queued = false;
            return self.trigger();
        }
        Vec::new()
    }

    /// Tell the pass service the work it asked of this one has ended.
    fn report(ctx: &Ctx, kind: wire::roll_reported::Kind) {
        ctx.post(
            crate::passes::service::NAME,
            wire::ScreenEvent {
                kind: Some(E::RollReported(wire::RollReported { kind: Some(kind) })),
            },
        );
    }

    fn walk(&mut self) -> Option<&mut Walk> {
        match self.job.as_mut() {
            Some(Job::Walk(walk)) => Some(walk),
            _ => None,
        }
    }

    // ---- the walk ----

    fn permission_read(&mut self, ctx: &Ctx, read: Permission, why: Why) -> Vec<wire::Effect> {
        self.permission = read;
        match why {
            Why::Sync => Vec::new(),
            Why::Ask => {
                if can_enumerate(read) {
                    self.trigger()
                } else {
                    Vec::new()
                }
            }
            Why::Walk => {
                if !can_enumerate(read) {
                    // THE GRID IS UNAFFECTED and the backup is idle. Two planes, two permissions:
                    // a denied photo grant must never blank a library the member already owns.
                    let reason = permission_sentence(ctx.locale(), read);
                    self.publish(wire::PhotosBackupPhase::Idle, 0, 0, reason);
                    return self.end(ctx);
                }
                self.begin_page()
            }
        }
    }

    fn begin_page(&mut self) -> Vec<wire::Effect> {
        self.publish(wire::PhotosBackupPhase::Enumerating, 0, 0, String::new());
        self.wait = Wait::Cursor;
        vec![keychain(
            wire::keychain_op::Op::Get,
            &cursor_key(&self.vault_id),
            "",
        )]
    }

    fn cursor_read(&mut self, found: &wire::KeychainValue) -> Vec<wire::Effect> {
        let cursor = if found.found {
            String::from_utf8_lossy(&found.value).into_owned()
        } else {
            String::new()
        };
        let Some(walk) = self.walk() else {
            return Vec::new();
        };
        walk.cursor.clone_from(&cursor);
        self.wait = Wait::Page;
        vec![effect(wire::effect::Kind::RollPage(wire::RollPage {
            cursor,
            limit: PAGE,
        }))]
    }

    fn paged(&mut self, ctx: &Ctx, page: wire::RollPaged) -> Vec<wire::Effect> {
        let key = cursor_key(&self.vault_id);
        let Some(walk) = self.walk() else {
            return Vec::new();
        };
        walk.passes += 1;
        if page.assets.is_empty() {
            // A PLATFORM MAY MOVE THE CURSOR WITH NOTHING TO OFFER (iOS trades a finished first
            // walk for a change token) and it is kept.
            let mut effects = Vec::new();
            if !page.next_cursor.is_empty() && page.next_cursor != walk.cursor {
                effects.push(keychain(
                    wire::keychain_op::Op::Set,
                    &key,
                    &page.next_cursor,
                ));
            }
            // NOTHING NEW IS "DONE", NOT "IDLE": a member whose roll is fully backed up must be
            // able to tell that from a backup that is off.
            self.publish(wire::PhotosBackupPhase::Done, 0, 0, String::new());
            effects.extend(self.end(ctx));
            return effects;
        }
        walk.enumerated = page.assets.len();
        walk.assets = page.assets.into();
        walk.next_cursor = page.next_cursor;
        walk.exhausted = page.exhausted;
        walk.queued = 0;
        walk.held = 0;
        walk.skipped = 0;
        walk.moved = 0;
        self.next_asset(ctx)
    }

    fn next_asset(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(walk) = self.walk() else {
            return Vec::new();
        };
        let Some(asset) = walk.assets.pop_front() else {
            return self.page_done(ctx);
        };
        let left = walk.assets.len() + 1;
        walk.offer = Some(Offer {
            todo: asset.resources.iter().cloned().collect(),
            asset,
            current: None,
            camera_asset: None,
            camera_bytes: 0,
            queued: None,
            left,
            staged: None,
        });
        self.next_resource(ctx)
    }

    /// The next resource of the asset, or the asset is done.
    fn next_resource(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(offer) = self.walk().and_then(|walk| walk.offer.as_mut()) else {
            return Vec::new();
        };
        let Some(resource) = offer.todo.pop_front() else {
            return self.asset_done(ctx);
        };
        let role = wire::roll_resource::Role::try_from(resource.role)
            .unwrap_or(wire::roll_resource::Role::Unspecified);
        let asset_video = offer.asset.kind == wire::roll_asset::Kind::Video as i32;
        offer.current = Some(Resource {
            reference: resource.r#ref,
            camera: role == wire::roll_resource::Role::CameraOriginal,
            original: role == wire::roll_resource::Role::Original,
            video: role == wire::roll_resource::Role::PairedVideo || asset_video,
        });
        // BEFORE EACH RESOURCE: a phone that leaves Wi-Fi half way through a roll stops
        // downloading from iCloud there.
        self.wait = Wait::Link;
        vec![effect(wire::effect::Kind::LinkRead(wire::LinkRead {}))]
    }

    fn linked(&mut self, link: &wire::LinkReading) -> Vec<wire::Effect> {
        if let Some(Job::Feed(feed)) = self.job.as_mut() {
            let Some(need) = feed.current.as_ref() else {
                return Vec::new();
            };
            // Only a photograph may cross a metered link: anything that is not an image is "a video".
            let video = !need.media_type.starts_with("image/");
            self.wait = Wait::Stage;
            return vec![effect(wire::effect::Kind::LibraryStage(
                wire::LibraryStage {
                    r#ref: need.os_ref.clone(),
                    allow_network: may_fetch(link, video),
                    changed_in_place: false,
                    media_type: need.media_type.clone(),
                    byte_size: need.size,
                },
            ))];
        }
        let Some(offer) = self.walk().and_then(|walk| walk.offer.as_ref()) else {
            return Vec::new();
        };
        let Some(resource) = offer.current.as_ref() else {
            return Vec::new();
        };
        let request = wire::LibraryStage {
            r#ref: resource.reference.clone(),
            allow_network: may_fetch(link, resource.video),
            // The lookup of what the vault last filed this ref as comes BEFORE the new bytes are
            // staged: afterwards the ref names both.
            changed_in_place: offer.asset.changed_in_place && resource.original,
            media_type: String::new(),
            byte_size: 0,
        };
        self.wait = Wait::Stage;
        vec![effect(wire::effect::Kind::LibraryStage(request))]
    }

    fn staged(&mut self, ctx: &Ctx, staged: wire::LibraryStaged) -> Vec<wire::Effect> {
        if matches!(self.job, Some(Job::Feed(_))) {
            return self.fed(ctx, &staged);
        }
        use wire::library_staged::Outcome as O;
        let outcome = O::try_from(staged.outcome).unwrap_or(O::Unspecified);
        let (original, left) = match self.walk().and_then(|walk| walk.offer.as_ref()) {
            Some(offer) => (
                offer
                    .current
                    .as_ref()
                    .is_some_and(|resource| resource.original),
                offer.left,
            ),
            None => return Vec::new(),
        };
        let queued = self.walk().map_or(0, |walk| walk.queued);
        match outcome {
            O::InCloud => {
                // THE CURSOR STAYS BEFORE IT: a keyset cannot skip one asset and come back, so the
                // walk waits here for a link the rule lets the download cross.
                self.backup = wire::PhotosBackupChanged {
                    phase: wire::PhotosBackupPhase::WaitingForUnmetered as i32,
                    assets_transferred_this_session: queued,
                    assets_remaining: u32::try_from(left).unwrap_or(u32::MAX),
                    paused_reason: words::in_cloud(ctx.locale()),
                };
                self.end(ctx)
            }
            // A STILL THAT IS GONE IS THE ASSET GONE; a movie, or a camera original Photos no
            // longer holds, costs the edit nothing: it comes in without a lineage.
            O::Gone => {
                if original {
                    if let Some(walk) = self.walk() {
                        walk.skipped += 1;
                        walk.offer = walk.offer.take().map(|mut offer| {
                            offer.todo.clear();
                            offer.queued = None;
                            offer
                        });
                    }
                    self.asset_done(ctx)
                } else {
                    self.next_resource(ctx)
                }
            }
            O::Failed | O::Unspecified => {
                let sentence = if staged.sentence.is_empty() {
                    words::photo_unreadable(ctx.locale())
                } else {
                    staged.sentence
                };
                self.refused(ctx, sentence, left)
            }
            O::Ready => self.commit(ctx, staged),
        }
    }

    /// ONE PHOTOGRAPH'S REFUSAL IS NOT THE PASS'S, but the cursor is NOT advanced past it, so the
    /// next pass tries it again: a transient refusal must not silently cost a photograph.
    fn refused(&mut self, ctx: &Ctx, sentence: String, left: usize) -> Vec<wire::Effect> {
        let queued = self.walk().map_or(0, |walk| walk.queued);
        self.backup = wire::PhotosBackupChanged {
            phase: wire::PhotosBackupPhase::ParkedLowDisk as i32,
            assets_transferred_this_session: queued,
            assets_remaining: u32::try_from(left).unwrap_or(u32::MAX),
            paused_reason: sentence,
        };
        self.end(ctx)
    }

    fn commit(&mut self, ctx: &Ctx, staged: wire::LibraryStaged) -> Vec<wire::Effect> {
        let Some(offer) = self.walk().and_then(|walk| walk.offer.as_mut()) else {
            return Vec::new();
        };
        let Some(resource) = offer.current.as_ref() else {
            return Vec::new();
        };
        let (camera, original, video) = (resource.camera, resource.original, resource.video);
        let left = offer.left;
        // AN EDIT'S SOURCE: the camera's file when the library kept it (iOS), else the version the
        // vault held for this ref (Android, where the editor overwrote the file). The SAME bytes
        // as the vault holds are no edit at all, and where the vault holds nothing for the ref the
        // edit is a photograph of its own.
        let source = if original {
            offer.camera_asset.clone().or_else(|| {
                (!staged.prior_asset_id.is_empty()
                    && staged.prior_content_hash != staged.content_hash)
                    .then(|| staged.prior_asset_id.clone())
            })
        } else {
            None
        };
        let request = add_request(
            &offer.asset,
            &staged.content_hash,
            staged.byte_size,
            &staged.media_type,
            video,
            source.as_deref(),
        );
        let key = kit_act::key(&["add-photo", &staged.content_hash], kit_act::fresh());
        let response = ctx.act(&wire::ActRequest::from(request).keyed(key));
        let added = match response {
            Ok(response) if response.status == wire::ActStatus::Executed as i32 => {
                serde_json::from_slice::<serde_json::Value>(&response.output)
                    .ok()
                    .and_then(|out| out.get("id").and_then(|id| id.as_str().map(str::to_owned)))
                    .unwrap_or_default()
            }
            Ok(response) => {
                let moved = response
                    .refusal
                    .as_ref()
                    .is_some_and(|refusal| refusal.check == "vault_moved");
                let sentence = if response.reason.is_empty() {
                    words::photo_refused(ctx.locale())
                } else {
                    response.reason
                };
                if moved {
                    // A FROZEN VAULT TAKES NO PHOTOGRAPHS (#1029 F1). IDLE and not parked: parked
                    // is a device out of disk, which resumes when space is freed, and this does
                    // not resume: the vault moved. The cursor stays, so a member who takes the
                    // vault back resumes from the photograph this pass stopped at.
                    self.publish(wire::PhotosBackupPhase::Idle, 0, 0, sentence);
                    return self.end(ctx);
                }
                return self.refused(ctx, sentence, left);
            }
            Err(_) => return self.refused(ctx, words::photo_refused(ctx.locale()), left),
        };
        let Some(offer) = self.walk().and_then(|walk| walk.offer.as_mut()) else {
            return Vec::new();
        };
        if camera {
            offer.camera_asset = (!added.is_empty()).then_some(added);
            offer.camera_bytes += staged.byte_size;
        } else if original {
            offer.queued = Some((staged.already_held, staged.byte_size + offer.camera_bytes));
            // A RE-WALK RENDERS NOTHING: the core already holds this original, and its derivatives
            // went in with it the first time. A RESTORED PHONE'S RE-WALK RENDERS ONLY WHAT THE
            // VAULT LACKS: the core says which tiers it holds.
            if !staged.already_held {
                let tiers: Vec<String> = ["thumb", "preview"]
                    .into_iter()
                    .filter(|tier| !staged.derivatives_held.iter().any(|held| held == tier))
                    .map(str::to_owned)
                    .collect();
                if !tiers.is_empty() {
                    let reference = resource_ref(offer);
                    offer.staged = Some(staged.clone());
                    self.wait = Wait::Derivatives;
                    return vec![effect(wire::effect::Kind::LibraryDerivatives(
                        wire::LibraryDerivatives {
                            r#ref: reference,
                            for_hash: staged.content_hash,
                            tiers,
                        },
                    ))];
                }
            }
        } else if let Some((held, bytes)) = offer.queued {
            offer.queued = Some((held, bytes + staged.byte_size));
        }
        self.next_resource(ctx)
    }

    /// An asset is offered whole (or skipped): count it, advance the cursor, say so.
    fn asset_done(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let key = cursor_key(&self.vault_id);
        let Some(walk) = self.walk() else {
            return Vec::new();
        };
        let Some(offer) = walk.offer.take() else {
            return Vec::new();
        };
        match offer.queued {
            Some((held, bytes)) => {
                walk.queued += 1;
                if held {
                    walk.held += 1;
                } else {
                    walk.imported += 1;
                }
                walk.moved += bytes;
            }
            None => {
                // Counted as skipped by the caller that dropped it, else nothing queued.
            }
        }
        let (queued, left) = (walk.queued, walk.assets.len());
        let mut effects = Vec::new();
        // ADVANCED PER ASSET. A pass the OS kills resumes where it was.
        if !offer.asset.after.is_empty() {
            effects.push(keychain(
                wire::keychain_op::Op::Set,
                &key,
                &offer.asset.after,
            ));
        }
        self.publish(
            wire::PhotosBackupPhase::Transferring,
            queued,
            left,
            String::new(),
        );
        effects.extend(self.next_asset(ctx));
        effects
    }

    /// A page is offered. The roll goes on while the last page ended mid-roll.
    fn page_done(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let key = cursor_key(&self.vault_id);
        let locale = ctx.locale();
        let permission = self.permission;
        let Some(walk) = self.walk() else {
            return Vec::new();
        };
        let mut effects = Vec::new();
        // THE PAGE'S OWN CURSOR LAST: it is the one the platform minted, and on iOS the one that
        // turns a finished walk into a change token.
        if !walk.next_cursor.is_empty() {
            effects.push(keychain(
                wire::keychain_op::Op::Set,
                &key,
                &walk.next_cursor,
            ));
        }
        let phase = if walk.exhausted {
            wire::PhotosBackupPhase::Done
        } else {
            wire::PhotosBackupPhase::Transferring
        };
        let (queued, again) = (walk.queued, !walk.exhausted && walk.passes < MAX_PASSES);
        // LIMITED IS SAID EVEN WHEN IT IS WORKING: a member who granted a selection must be able
        // to see that the other photographs are not missing by accident.
        self.publish(phase, queued, 0, permission_sentence(locale, permission));
        if again {
            // The permission is read again at each pass, as the OS may have changed it.
            effects.extend(self.ask_permission(false, Why::Walk));
        } else {
            effects.extend(self.end(ctx));
        }
        effects
    }

    // ---- the bytes the core asked for again ----

    fn feed(&mut self, ctx: &Ctx, needs: Vec<wire::NeededBytes>) -> Vec<wire::Effect> {
        if self.job.is_some() {
            self.needs_queued.extend(needs);
            return Vec::new();
        }
        self.job = Some(Job::Feed(Feed {
            needs: needs.into(),
            current: None,
            landed: 0,
        }));
        self.feed_next(ctx)
    }

    fn feed_next(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(Job::Feed(feed)) = self.job.as_mut() else {
            return Vec::new();
        };
        while let Some(need) = feed.needs.pop_front() {
            if need.os_ref.is_empty() {
                continue;
            }
            feed.current = Some(need);
            self.wait = Wait::Link;
            return vec![effect(wire::effect::Kind::LinkRead(wire::LinkRead {}))];
        }
        let landed = feed.landed;
        self.job = None;
        self.wait = Wait::Nothing;
        self.fed_last_round = landed;
        self.fed_rounds += 1;
        Self::report(
            ctx,
            wire::roll_reported::Kind::Fed(wire::roll_reported::BytesFed { landed }),
        );
        // A walk that queued behind the round goes now.
        if self.walk_queued {
            self.walk_queued = false;
            return self.trigger();
        }
        Vec::new()
    }

    /// One need was staged again: only the hash asked for counts. A ref that no longer finds
    /// those bytes lands nothing, and the core stops asking once a round lands nothing new.
    fn fed(&mut self, ctx: &Ctx, staged: &wire::LibraryStaged) -> Vec<wire::Effect> {
        let _ = ctx;
        if let Some(Job::Feed(feed)) = self.job.as_mut() {
            let ready = staged.outcome == wire::library_staged::Outcome::Ready as i32;
            if let Some(need) = feed.current.take()
                && ready
                && staged.content_hash == need.content_hash
            {
                feed.landed += 1;
            }
        }
        self.feed_next(ctx)
    }
}

fn resource_ref(offer: &Offer) -> String {
    offer
        .current
        .as_ref()
        .map(|resource| resource.reference.clone())
        .unwrap_or_default()
}

impl Screen for Roll {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::effect_result::Outcome as O;
        match event.kind {
            // Read the OS grant onto the screen. A read, never an ask: a grant that landed after
            // the session attached must be on state before the member-visible frame.
            Some(E::Appeared(_)) if self.job.is_none() => self.ask_permission(false, Why::Sync),
            Some(E::ImportsCameraRoll(roll)) => {
                // THE VAULT THE ROLL IS OFFERED TO: the cursor is per vault.
                if !roll.vault_id.is_empty() {
                    self.vault_id = roll.vault_id.clone();
                }
                match roll.kind {
                    Some(C::Requested(requested)) => {
                        use wire::imports_camera_roll_event::requested::Action;
                        match Action::try_from(requested.action).unwrap_or(Action::Unspecified) {
                            // A prompt over a running job would clobber what it waits on; a job that
                            // runs means the grant already allows it.
                            Action::AskPermission if self.job.is_some() => Vec::new(),
                            Action::AskPermission => self.ask_permission(true, Why::Ask),
                            Action::ImportNow => self.trigger(),
                            Action::ReadPermission if self.job.is_some() => Vec::new(),
                            Action::ReadPermission => self.ask_permission(false, Why::Sync),
                            Action::Unspecified => Vec::new(),
                        }
                    }
                    // A NEW CAPTURE WHILE THE APP IS ON SCREEN: a nudge to run the ordinary pass, never
                    // a second way to learn what is new. The cursor is the durable answer.
                    Some(C::LibraryChanged(_) | C::Walk(_)) => self.trigger(),
                    Some(C::BytesNeeded(needed)) => self.feed(ctx, needed.needs),
                    None => Vec::new(),
                }
            }
            Some(E::EffectResult(result)) => {
                let Some(outcome) = result.outcome else {
                    return Vec::new();
                };
                match (std::mem::replace(&mut self.wait, Wait::Nothing), outcome) {
                    (Wait::Permission(why), O::LibraryPermissionRead(read)) => {
                        let permission =
                            Permission::try_from(read.permission).unwrap_or(Permission::NotAsked);
                        self.permission_read(ctx, permission, why)
                    }
                    (Wait::Cursor, O::Keychain(found)) => self.cursor_read(&found),
                    (Wait::Page, O::RollPaged(page)) => self.paged(ctx, page),
                    (Wait::Link, O::LinkReading(link)) => self.linked(&link),
                    (Wait::Stage, O::LibraryStaged(staged)) => self.staged(ctx, staged),
                    (Wait::Derivatives, O::Done(_) | O::Failed(_)) => {
                        // A derivative that fails costs nothing but itself: the original is
                        // committed already, and the grid falls back to it.
                        self.next_resource(ctx)
                    }
                    // A shell that cannot answer an effect leaves the job where it was: a pass
                    // that did nothing, and the next trigger tries again.
                    (
                        Wait::Permission(_) | Wait::Cursor | Wait::Page | Wait::Link | Wait::Stage,
                        O::Failed(_),
                    ) => self.end(ctx),
                    // The write of a cursor and every other answer nobody waits on.
                    (wait, _) => {
                        self.wait = wait;
                        Vec::new()
                    }
                }
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState {
            kind: Some(wire::view_state::Kind::ImportsCameraRoll(
                wire::ImportsCameraRollState {
                    permission: self.permission as i32,
                    backup: Some(self.backup.clone()),
                    imported_total: self.imported_total,
                    fed_last_round: self.fed_last_round,
                    fed_rounds: self.fed_rounds,
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
