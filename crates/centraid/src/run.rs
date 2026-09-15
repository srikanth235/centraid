//! What each subcommand does.
//!
//! Only `gateway`, `pair --mint` and `seat pair` run for real in this lane; the
//! rest name the lane that owns them and exit 3. The split is deliberate: a
//! subcommand that pretends to work is worse than one that says it does not.

use std::path::{Path, PathBuf};

use centraid_net::endpoint::{Endpoint, EndpointConfig, RelayMode};
use centraid_net::{MemoryAllowlist, pairing, ticket};

use crate::exit;

/// The gateway's long-term endpoint identity, in the key store beside the
/// vault. One name, stated once: a second spelling would be a second gateway.
const GATEWAY_ENDPOINT_KEY: &str = "gateway.endpoint.key";

/// One line on stderr, so stdout stays parseable. `RUST_LOG`-style filters
/// through `--log` / `CENTRAID_LOG`.
pub fn install_tracing(filter: Option<&str>) {
    let env =
        tracing_subscriber::EnvFilter::try_new(filter.unwrap_or("centraid=info,centraid_net=info"))
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(env)
        .with_writer(std::io::stderr)
        .try_init();
}

/// The verb exists and its implementation lands in a later lane.
pub fn not_yet_available(verb: &str, owner: &str) -> u8 {
    eprintln!("centraid: `{verb}` is not available in this build — {owner} (#1020).");
    eprintln!(
        "centraid: exiting {} rather than pretending to work.",
        exit::NOT_YET_AVAILABLE
    );
    exit::NOT_YET_AVAILABLE
}

pub struct GatewayArgs {
    pub data_dir: Option<PathBuf>,
    /// HOW MANY PAIR TICKETS TO MINT AT STARTUP (#1025 S3).
    ///
    /// A count and not a flag, because a member with a phone AND a tablet needs
    /// two codes and a ticket is one-shot by design — burned by redemption, so
    /// the second device cannot reuse the first's. `--print-qr` with no value
    /// is one, which is every existing invocation.
    pub print_qr: u8,
    pub vault_name: String,
    pub relay: Option<String>,
    pub no_relay: bool,
}

fn relay_mode(relay: Option<String>, no_relay: bool) -> RelayMode {
    match (relay, no_relay) {
        (_, true) => RelayMode::Disabled,
        (Some(url), false) => RelayMode::Custom(url),
        (None, false) => RelayMode::Default,
    }
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default()
}

/// The line every wrapper waits for. A fixed prefix on stdout, because a test
/// and a systemd unit both need to know the endpoint is up, and "grep the log
/// for something that looks right" is not a contract.
pub const READY_LINE: &str = "centraid gateway ready";

/// Run the gateway until Ctrl-C.
///
/// **No TCP listener.** iroh is QUIC over UDP and nothing here binds a
/// `TcpListener`; `tests/no_listener.rs` spawns this very binary, waits for
/// [`READY_LINE`], and asserts through `/proc/net/tcp*` that the process owns
/// no LISTEN socket.
pub async fn gateway(args: GatewayArgs) -> u8 {
    // THE STALE-ARTIFACT REFUSAL on the binary path (#1020 Artifacts,
    // D-1020-G2). A shell that spawns this gateway — the Electron seat, a
    // systemd unit written by a release it recorded the digest of — sets
    // `CENTRAID_EXPECTED_CORE_DIGEST` to the digest ITS build was made against.
    // A mismatch is refused here, before the endpoint binds and before one
    // query is answered from a schema the caller stopped speaking. Unset means
    // nobody claimed an expectation, which is a developer running the binary by
    // hand; it is not treated as a match.
    if let Ok(expected) = std::env::var("CENTRAID_EXPECTED_CORE_DIGEST") {
        let identity = centraid_core::identity::ArtifactIdentity::current();
        match centraid_core::identity::require_digest(&identity, &expected) {
            Ok(None) => {}
            Ok(Some(warning)) => eprintln!("centraid: {warning}"),
            Err(refusal) => {
                eprintln!("centraid: {refusal}");
                return exit::REFUSED;
            }
        }
    }

    // THE GATEWAY'S OWN IDENTITY, AND IT IS LONG-TERM (#1025 S7,
    // **D-1025-S7-8x**).
    //
    // A persisted allowlist is only half of "a paired seat still works after a
    // restart". `EndpointConfig::default()` mints a fresh secret key, and
    // `EndpointConfig::secret_key`'s own doc says what that means: "an identity
    // that changes is a gateway every paired seat stops recognising". The
    // pairing record a phone keeps names the gateway by its endpoint id, so a
    // gateway that re-minted its key was unreachable at the only address its
    // seats had — before admission was even asked.
    //
    // It lives in the KEY STORE beside the vault (`<data-dir>/keys`), which is
    // the directory export, backup and copy gestures deliberately do not move:
    // a copied vault must not come with the authority to answer as its gateway.
    // A gateway with no `--data-dir` has nowhere to keep it and mints a fresh
    // one, which is the ephemeral run it already was.
    let secret_key = args.data_dir.as_ref().and_then(|dir| {
        let keys = centraid_vault::custody::KeyStore::new(crate::cmd::keys_dir_in(dir));
        for warning in keys.take_warnings() {
            eprintln!("centraid: {warning}");
        }
        match keys.load_or_create(GATEWAY_ENDPOINT_KEY) {
            Ok(secret) => <[u8; 32]>::try_from(secret.as_slice())
                .ok()
                .map(|bytes| centraid_net::endpoint::EndpointSecretKey::from_bytes(&bytes)),
            Err(error) => {
                // NOT FATAL, AND SAID OUT LOUD. A gateway that cannot keep its
                // identity still serves this run; what it must not do is fail
                // to mention that every seat will have to pair again.
                eprintln!(
                    "centraid: this gateway could not keep its endpoint identity ({error}); \
                     it minted a fresh one and every paired seat must pair again."
                );
                None
            }
        }
    });
    let config = EndpointConfig {
        relay: relay_mode(args.relay, args.no_relay),
        secret_key,
        ..EndpointConfig::default()
    };
    let endpoint = match Endpoint::spawn(config).await {
        Ok(endpoint) => endpoint,
        Err(error) => {
            eprintln!("centraid: the endpoint would not bind: {error}");
            return exit::REFUSED;
        }
    };

    // The allowlist is built BELOW, once it is known whether there is a vault
    // to keep it in (#1025 S7, D-1025-S7-8x).
    let mut capture = None;
    // Remembered before `capture` is moved into the tick, because the seat lane
    // opens its own reader over the same file.
    let mut vault_file: Option<PathBuf> = None;
    let mut vault_id: Option<String> = None;
    // The vault's own `display_name`, once there is a vault to ask.
    let mut vault_display_name: Option<String> = None;
    // THE BYTE PLANE'S INDEX, and it is NOT `<data-dir>/blobs` (#1020,
    // D-1020-B1). That path is `cmd::blobs_dir_in`, the BACKUP plane's shared
    // artefact store, and putting an iroh-blobs index over it would have two
    // stores writing one directory under two naming schemes. It is per vault
    // for the same reason the content CAS is: a vault handed to someone else
    // is handed over whole, and a sibling directory travels with its file.
    let mut bytes_dir: Option<PathBuf> = None;
    // Where the bootstrap artifact is BUILT (#1025 S1). Scratch: the bytes a
    // seat fetches come from the byte store, which took its own copy.
    let mut snapshot_dir: Option<PathBuf> = None;
    match &args.data_dir {
        Some(dir) => {
            match open_or_found_vault(dir, &args.vault_name) {
                Ok(founded) => {
                    eprintln!(
                        "centraid: vault {} at {}",
                        founded.vault_id,
                        founded.file.display()
                    );
                    vault_file = Some(founded.file.clone());
                    vault_id = Some(founded.vault_id.clone());
                    vault_display_name = Some(founded.display_name.clone());
                    bytes_dir = Some(founded.file.with_extension("bytes"));
                    // ITS OWN DIRECTORY, not `snapshot::pre_migration_dir`.
                    // That one holds the copies a migration can be rolled back
                    // to, and this keeper sweeps everything but the current
                    // artifact — pointing them at one directory would delete
                    // the safety copy to save the space of a bootstrap.
                    snapshot_dir = Some(founded.file.with_extension("snapshots"));
                    capture = Some(founded);
                }
                Err(why) => {
                    eprintln!("centraid: {why}");
                    return exit::REFUSED;
                }
            }
        }
        None => eprintln!(
            "centraid: no --data-dir, so there is no vault and the allowlist is in memory. \
             Nothing this run does survives it."
        ),
    }

    // THE WAL CAPTURE TICK (#1020, D-1020-G9). `rpoSeconds` is the tick, which
    // is the whole point of the number: "how much can I lose" and "how often do
    // I ship" are one thing the owner sets once. Lane R built the seal and the
    // replay ordering and named the missing tick as a gap; this is the loop.
    //
    // It runs in the GATEWAY because the gateway holds the one writable
    // connection: a tick anywhere else would be reading a WAL whose end it
    // cannot bound. A failed tick logs and the loop continues — one bad tick
    // must not take the gateway down, and the next tick's segment simply starts
    // at the same offset.
    // `_held` is the gateway's one writable connection. It must outlive the
    // capture loop: dropping it checkpoints the WAL away.
    let (_held, ticking) = match capture {
        None => (None, None),
        Some(founded) => {
            let policy = centraid_vault::backup::BackupPolicy::default();
            let interval = std::time::Duration::from_millis(policy.capture_tick_ms());
            let mut capture = founded.capture;
            let data_dir = founded.data_dir;
            let task = tokio::spawn(async move {
                let mut ticks = 0_u64;
                let mut sealed = 0_u64;
                loop {
                    tokio::time::sleep(interval).await;
                    let generation = crate::cmd::capture::pending_tail(&data_dir)
                        .map(|tail| tail.len() as u64)
                        .unwrap_or(0)
                        + 1;
                    let tick_ms = now_ms();
                    ticks += 1;
                    let outcome = capture.tick(generation, tick_ms);
                    let last = match &outcome {
                        Ok(Some(segment)) => {
                            sealed += 1;
                            tracing::info!(
                                group = segment.group,
                                start = segment.start_offset,
                                end = segment.end_offset,
                                "a WAL segment was sealed"
                            );
                            Some(segment)
                        }
                        Ok(None) => {
                            tracing::debug!("capture tick: the WAL has not grown");
                            None
                        }
                        Err(error) => {
                            tracing::warn!(%error, "a capture tick failed");
                            None
                        }
                    };
                    // THE LIVENESS MARKER, written on EVERY tick including the
                    // ones that sealed nothing. "You can lose at most
                    // rpoSeconds" is a claim about a loop, and a loop that is
                    // running and a loop that is dead look identical from
                    // outside when there is nothing to capture.
                    if let Err(error) =
                        crate::cmd::capture::record_tick(&data_dir, tick_ms, ticks, sealed, last)
                    {
                        tracing::warn!(%error, "the capture tick could not record that it ran");
                    }
                }
            });
            (Some(founded.vault), Some(task))
        }
    };

    // THE SEAT LANE'S READER (#1020, lane D2).
    //
    // A SECOND core over the same file, and the second-ness is the design. The
    // gateway is the vault's single WRITER and `_held` above is that writer;
    // this one answers `LogRequest` and nothing else (`seat_lane`'s header says
    // why), so it never contends for the write lock. SQLite in WAL mode serves
    // readers alongside one writer, which is what makes a replica able to catch
    // up while the owner is still typing.
    //
    // `create: false` on purpose: by here the file exists, and a gateway that
    // silently founded a SECOND vault because a path was wrong would serve a
    // seat an empty log that applies cleanly.
    let core = match vault_file {
        None => None,
        Some(file) => {
            let config = centraid_core::CoreConfig {
                pairing: None,
                path: file.clone(),
                role: centraid_core::Role::Gateway,
                ui_thread_name: None,
                create: false,
                clock: None,
                ids: None,
                // A GATEWAY IS NOT A SEAT. Its endpoint identity is its own
                // and this field is the seat's (#1025 S5).
                expected_digest: None,
            };
            match centraid_core::Core::open(config) {
                Ok(handle) => Some(std::sync::Arc::new(handle)),
                Err(error) => {
                    // Not fatal. Pairing still works and the vault is still
                    // captured; what a seat gets is the refusal in the accept
                    // arm, which names the cause.
                    tracing::warn!(
                        %error,
                        file = %file.display(),
                        "no core for the seat lane; this gateway can pair and cannot serve changes"
                    );
                    None
                }
            }
        }
    };

    // THE ALLOWLIST, AND IT SURVIVES THIS PROCESS (#1025 S7, **D-1025-S7-8x**,
    // superseding D-1020-C8's placeholder).
    //
    // Built HERE and not at the top, because which store it is depends on
    // whether there is a vault: enrolment is a fact about the vault, and it is
    // kept in the vault's own `access_device` rows — the same rows
    // `centraid devices list` and `centraid devices revoke` already read and
    // write. See `crate::allowlist` for why that is where it belongs and for
    // the two deliberate differences from the in-memory store.
    //
    // A gateway with no `--data-dir` has no vault, keeps its enrolments in
    // memory, and says so on the line below rather than in a warning printed
    // whether it was true or not.
    let allowlist = std::sync::Arc::new(match core.clone() {
        Some(core) => crate::allowlist::GatewayAllowlist::durable(core),
        None => crate::allowlist::GatewayAllowlist::memory(),
    });
    if !allowlist.is_durable() && args.data_dir.is_some() {
        // A data directory whose vault would not open. Pairing still works for
        // this run and nothing it enrols outlives it, which is a different fact
        // from "you passed no --data-dir" and is stated as one.
        eprintln!(
            "centraid: this gateway has no core, so its allowlist is in memory: \
             every pairing in this run is lost on exit."
        );
    }

    // THE TAIL'S TWO HALVES (#1025 S2, D-1025-S7-40).
    //
    // `commits` is the wake a tailing seat parks on, and the CORE rings it:
    // every request that may have written this vault ends with a ring, and the
    // stream serving a seat reads the log from where it left off. This is the
    // one registration, at startup, and every tail on every connection hangs
    // off it — which is also why the ring carries no payload.
    //
    // `tails` is who is holding one. Presence falls out of it and stops at a
    // log line; see `crate::tails`.
    let commits = crate::tails::Commits::new();
    let tails = crate::tails::Tails::default();
    if let Some(core) = core.as_ref() {
        core.watch_commits(std::sync::Arc::new(commits.clone()));
    }

    // THE BYTE PLANE (#1020, D-1020-B1).
    //
    // Opened once and shared by every byte-lane connection: `ByteStore` is a
    // handle over one `redb` index, and a second store over the same directory
    // would be a second index over one set of files.
    //
    // Non-fatal, exactly like the seat-lane core above. A gateway that cannot
    // open its blob store can still pair and still serve rows; what a seat gets
    // is a `blob` stream that refuses, which shows up as photographs that have not
    // arrived rather than as a gateway that will not start.
    let blobs = match bytes_dir {
        None => None,
        Some(root) => match centraid_blobs::ByteStore::open(&root).await {
            // ONE STORE, AND THERE IS NOTHING TO IMPORT INTO IT (#1025 S3,
            // D-1025-S3-1). This used to sweep the vault's flat `<vault>.blobs`
            // CAS in on every start, because the vault wrote one store and the
            // byte plane served another. The vault writes THIS one now, so an
            // import would be importing the store into itself.
            Ok(store) => Some(store),
            Err(error) => {
                tracing::warn!(
                    %error,
                    root = %root.display(),
                    "no byte store; this gateway can serve rows and cannot serve files"
                );
                None
            }
        },
    };

    // THE VAULT'S BYTE DOOR, OVER THE STORE THE SEAT LANE SERVES FROM (#1025
    // S3, D-1025-S3-1). One store per vault on this device: `media.add_asset`
    // spills into the bytes a seat can fetch, `content_location` answers with
    // iroh's own data file, and a photograph a phone sent is the same blob a
    // second phone asks for.
    //
    // Attached after `Core::open` because opening the store is asynchronous and
    // opening a core is not. A gateway with no store holds text and refuses
    // photographs, by name — which is the same honest state it was in before,
    // and not a gateway that will not start.
    if let (Some(handle), Some(store)) = (core.as_ref(), blobs.as_ref()) {
        handle.attach_bytes(centraid_blobs::ContentBytes::new(
            store.clone(),
            tokio::runtime::Handle::current(),
        ));
    }

    // THE BACKFILL SWEEP (#1025 S3, D-1025-S7-53). A vault founded before
    // derivatives existed holds originals and no tiers, and a fresh device
    // paired to it sees the very defect this slice fixes: "thumbnails always"
    // fetching nothing. Bounded and resumable, so a large old roll converges
    // over several starts; a vault already swept selects nothing and writes
    // nothing. Runs AFTER `attach_bytes`, because it has bytes to read.
    //
    // Non-fatal, like every other start step here: a sweep that fails is a
    // gateway that serves rows and originals, which is exactly where it was.
    if let Some(handle) = core.as_ref() {
        match handle.derive_missing_tiers(centraid_vault::commands::media::DERIVE_SWEEP_LIMIT) {
            Ok(0) => {}
            Ok(derived) => tracing::info!(
                derived,
                "derived the missing thumbnail and preview tiers for content this vault \
                 committed before the gateway made them"
            ),
            Err(error) => tracing::warn!(
                %error,
                "the derivative backfill did not run; originals still serve and the next \
                 start tries again"
            ),
        }
    }

    // THE BOOTSTRAP BLOB'S KEEPER (#1025 S1). Needs both halves — a place to
    // build the artifact and a store to put it in — so a gateway missing
    // either serves rows and refuses bootstraps by name, which is a seat that
    // says "the gateway has nowhere to build a copy" rather than one that
    // hangs.
    let snapshots = match (snapshot_dir, blobs.clone()) {
        (Some(dir), Some(store)) => Some(crate::snapshots::Snapshots::new(dir, store)),
        _ => None,
    };

    // The accept loop. A refused connection is logged and the loop continues:
    // one impostor must not take the gateway down.
    let serving = {
        let endpoint = endpoint.clone();
        let allowlist = allowlist.clone();
        // THE VAULT'S OWN NAME WHERE THERE IS ONE (#1025 S7-9). The flag is the
        // fallback for a gateway with no `--data-dir`, which has no vault to
        // ask — and which serves no pairing either.
        let vault_name = vault_display_name.clone().unwrap_or_else(|| args.vault_name.clone());
        let vault_id = vault_id.clone();
        let core = core.clone();
        let blobs = blobs.clone();
        let snapshots = snapshots.clone();
        let commits = commits.clone();
        let tails = tails.clone();
        tokio::spawn(async move {
            loop {
                match endpoint.accept(allowlist.as_ref()).await {
                    Ok(None) => break,
                    // THE ONE PLANE, AND A CONNECTION IS IN ONE OF TWO STATES
                    // (#1025 S3, D-1025-S3-4).
                    //
                    // `accept` looked the peer key up once; `device` is `Some`
                    // for an enrolled, unrevoked device and `None` for everyone
                    // else. Both go to the same lane, and the lane serves a
                    // PROVISIONAL connection one `pair` stream and promotes it
                    // in place if the ticket redeems — so a phone pairs and
                    // bootstraps on one dial.
                    //
                    // There used to be two arms here and two ALPNs, and for a
                    // while a third arm for `centraid/v1/byte` was unreachable
                    // because the arm above it matched every lane but `PAIR`.
                    // The compiler said so; nothing at runtime would have.
                    Ok(Some(accepted)) => {
                        let device = accepted
                            .device
                            .as_ref()
                            .map(|device| device.device_id.clone())
                            .unwrap_or_default();
                        let Some(core) = core.clone() else {
                            // A gateway with no `--data-dir` has no vault, so
                            // it has no log. Saying so beats an empty page,
                            // which a seat would apply as "nothing changed".
                            tracing::warn!(
                                %device,
                                "a device connected and this gateway holds no vault; \
                                 start it with --data-dir"
                            );
                            continue;
                        };
                        let lane = crate::seat_lane::Lane {
                            handle: core,
                            snapshots: snapshots.clone(),
                            blobs: blobs.clone(),
                            device_id: device.clone(),
                            commits: commits.clone(),
                            tails: tails.clone(),
                        };
                        let pairing = crate::seat_lane::Pairing {
                            allowlist: allowlist.clone(),
                            vault_id: vault_id.clone().unwrap_or_default(),
                            vault_name: vault_name.clone(),
                            gateway_address: hex(&endpoint.id()),
                            // THE HINTS THE TICKET CARRIES, CARRIED AGAIN ON
                            // THE ANSWER (#1025 S7, item 3). The shell persists
                            // the pairing record in its secure store before
                            // there is a replica to put it in, and one with no
                            // way to dial is a durable identity presented to
                            // nobody.
                            //
                            // THE ENDPOINT AND NOT THE ANSWER, because reading
                            // the answer is an `await`: `Endpoint::addr` waits
                            // on the address watcher, and awaiting it anywhere
                            // in the ACCEPT LOOP — which is one task — stalls
                            // every other device trying to connect. It is read
                            // inside the per-connection task instead.
                            endpoint: endpoint.clone(),
                        };
                        // ONE TASK PER CONNECTION, so a slow replica cannot
                        // hold the accept loop and the next device can still
                        // pair. The connection is MOVED into it: a seat's
                        // window can end at any moment and holding `accepted`
                        // for the task's length is what keeps QUIC from
                        // discarding stream data the seat has not read
                        // (D-1020-G10).
                        tokio::spawn(async move {
                            match crate::seat_lane::serve(
                                &accepted.connection,
                                lane,
                                env!("CARGO_PKG_VERSION"),
                                &pairing,
                            )
                            .await
                            {
                                crate::seat_lane::Ended::PeerClosed { streams, rows } => {
                                    tracing::info!(%device, streams, rows, "a seat's window closed");
                                }
                                crate::seat_lane::Ended::Failed(why) => {
                                    tracing::warn!(%device, %why, "the seat plane ended");
                                }
                                crate::seat_lane::Ended::Unredeemed(why) => {
                                    // A STRANGER, not a device. Its own line
                                    // because the operator's question is
                                    // different: this is somebody who reached
                                    // the gateway and did not pair, which on a
                                    // public relay is ordinary and on a LAN is
                                    // worth a look.
                                    tracing::info!(%why, "an unenrolled peer did not pair");
                                    // AND THE CONNECTION GOES, on this side
                                    // (#1025 S3). A stranger must not be left
                                    // holding a connection to a gateway it has
                                    // no business on, and it will not close one
                                    // it is squatting on. The wait below
                                    // delivers the refusal first; this is what
                                    // happens when the peer does not close.
                                    let _ = tokio::time::timeout(
                                        std::time::Duration::from_secs(2),
                                        accepted.connection.closed(),
                                    )
                                    .await;
                                    accepted.connection.close_unauthorized();
                                }
                            }
                            // THE CLOSE HANDSHAKE (#1020, D-1020-G10). Dropping
                            // the connection sends CONNECTION_CLOSE and
                            // discards anything the peer has not read — which
                            // for a refused pairing is a member told it failed
                            // on a device the gateway just enrolled. Waiting
                            // for the PEER's close is the synchronisation; the
                            // timeout is a backstop so a peer that never closes
                            // cannot hold a task.
                            let _ = tokio::time::timeout(
                                std::time::Duration::from_secs(10),
                                accepted.connection.closed(),
                            )
                            .await;
                            drop(accepted);
                        });
                    }
                    Err(error) => tracing::warn!(%error, "a connection was refused"),
                }
            }
        })
    };

    // READY IS AFTER THE ACCEPT LOOP EXISTS, AND THAT IS THE WHOLE POINT
    // (#1025 S7).
    //
    // It used to be printed — with the pairing ticket right behind it —
    // BEFORE the vault was opened, the byte store was opened and this task was
    // spawned. So every script that waits on this line, which is what the line
    // is for, got it while the gateway could not yet accept a connection: on a
    // seeded fixture that window was long enough for a phone to dial, wait out
    // its whole pairing timeout and be told the gateway did not answer, while
    // the gateway's own log said a peer had aborted a handshake.
    //
    // A gateway that says it is ready and then refuses connections is lying to
    // the one caller that believes it. Nothing here is slower; the line is
    // simply true now.
    println!("{READY_LINE} endpoint={}", hex(&endpoint.id()));

    for _ in 0..args.print_qr {
        match pairing::mint(&endpoint, allowlist.as_ref(), &args.vault_name, now_ms()).await {
            Ok(minted) => print_ticket(&minted.encoded),
            Err(error) => {
                eprintln!("centraid: could not mint a pair ticket: {error}");
                return exit::REFUSED;
            }
        }
    }

    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
    serving.abort();
    if let Some(ticking) = ticking {
        ticking.abort();
    }
    endpoint.close().await;
    exit::OK
}

/// What the gateway holds open for a data directory.
struct FoundedVault {
    vault_id: String,
    /// THE VAULT'S OWN NAME, read out of `core_vault` (#1025 S7-9).
    ///
    /// Not `args.vault_name`. That flag names a vault at FOUNDING and is a
    /// guess at every moment afterwards: a seeded fixture called "Tahoe Demo"
    /// was served to a pairing phone as "Centraid", because "Centraid" is the
    /// flag's default and the flag was what the answer carried.
    display_name: String,
    file: PathBuf,
    data_dir: PathBuf,
    capture: crate::cmd::capture::WalCapture,
    /// THE ONE WRITABLE CONNECTION, held for the life of the process.
    ///
    /// Not a formality, and not only the #1020 rule that the gateway is the
    /// vault's single writer. In WAL mode SQLite CHECKPOINTS AND REMOVES the
    /// `-wal` file when the last connection closes, so a gateway that opened
    /// the vault, founded it and closed the connection would leave the capture
    /// tick with nothing to read — the first generation's WAL tail would be
    /// empty and the RPO would silently be "since the last snapshot" again,
    /// which is the exact gap wave 2 lane R named. Holding it open is what
    /// makes the tick have bytes.
    ///
    /// It is not moved into the capture task because the tick needs no
    /// connection at all — it reads the `-wal` file.
    ///
    /// This comment used to say `Vault` "carries boxed `Clock` and `Ids` trait
    /// objects that are not `Send`". THAT WAS FALSE, and it cost the seat lane:
    /// both traits are declared `Send + Sync` (`crates/vault/src/clock.rs:19`,
    /// `:197`), `Vault` is `Send` and `Handle` is `Send + Sync`, so vault work
    /// can live in a `tokio::spawn` after all. `crates/core/tests/send.rs`
    /// asserts it at compile time now, so the claim cannot rot back.
    vault: centraid_vault::file::Vault,
}

/// Open the vault under a data directory, FOUNDING it if there is none.
///
/// Founding is two acts in `crates/vault` and deliberately so — `Vault::create`
/// makes a file with a schema and no facts, `Vault::found` writes the vault row
/// and its owner — and this is the one place that does both, because a gateway
/// pointed at an empty directory has to end up with a vault somebody owns or it
/// has nothing to serve. `centraid recover` restores a file that already has an
/// owner and never comes through here.
///
/// The vault file's directory is its vault id, which is the layout
/// `cmd::sole_vault_file` reads. It cannot be known before the vault is founded
/// (the id is generated inside the commit), so the file is created at a
/// temporary name and moved once it has one — rather than inventing an id
/// outside the vault and having two sources for it.
fn open_or_found_vault(data_dir: &Path, display_name: &str) -> Result<FoundedVault, String> {
    use centraid_vault::custody::KeyStore;
    use centraid_vault::file::Vault;

    std::fs::create_dir_all(crate::cmd::vault_dir_in(data_dir))
        .map_err(|error| format!("creating the vault directory: {error}"))?;

    let file = match crate::cmd::sole_vault_file(data_dir) {
        Ok(file) => file,
        Err(why) if why.starts_with("no vault under") => {
            let staging = crate::cmd::vault_dir_in(data_dir).join(".founding");
            let _ = std::fs::remove_dir_all(&staging);
            std::fs::create_dir_all(&staging)
                .map_err(|error| format!("creating {}: {error}", staging.display()))?;
            let staged = staging.join("vault.db");
            let vault = Vault::create(&staged)
                .map_err(|error| format!("founding a vault at {}: {error}", staged.display()))?;
            let founded = vault
                .found(display_name, "Owner")
                .map_err(|error| format!("writing the vault and owner rows: {error}"))?;
            drop(vault);
            let home = crate::cmd::vault_dir_in(data_dir).join(&founded.vault_id);
            std::fs::rename(&staging, &home)
                .map_err(|error| format!("moving the new vault to {}: {error}", home.display()))?;
            eprintln!(
                "centraid: FOUNDED a new vault {} (owner party {})",
                founded.vault_id, founded.owner_party_id
            );
            home.join("vault.db")
        }
        Err(why) => return Err(why),
    };

    // Opened, and KEPT open — see the `vault` field's comment. Opening also
    // migrates the file forward if it is behind, which is the other thing that
    // has to happen before anything serves from it.
    let vault =
        Vault::open(&file).map_err(|error| format!("opening {}: {error}", file.display()))?;
    // THE CONTENT STORE IS ATTACHED LATER, and not here (#1025 S3). Opening the
    // byte plane's store is asynchronous and this function is not; the gateway
    // opens `<vault>.bytes` once, beside the seat lane that serves from it, and
    // hands the SAME handle to this vault's byte door. Two stores over one
    // directory would be two indexes over one set of files, which is what
    // D-1025-S3-1 deleted.
    let vault_id = vault
        .vault_id()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| {
            format!(
                "{} has a schema and no vault row — it was created and never founded. `centraid \
                 recover` is the verb for a vault that exists elsewhere; this directory has a \
                 half-made one.",
                file.display()
            )
        })?;

    // The same master keyring `centraid backup now` uses, in the same place:
    // one directory to back up out-of-band, not two.
    let keys = KeyStore::new(crate::cmd::keys_dir_in(data_dir));
    let master = keys
        .load_or_create("backup.master.key")
        .map_err(|error| format!("backup master key: {error}"))?;
    for warning in keys.take_warnings() {
        eprintln!("centraid: {warning}");
    }
    let capture = crate::cmd::capture::WalCapture::open(data_dir, &file, vault_id.clone(), master)?;
    let display_name = vault
        .display_name()
        .map_err(|error| error.to_string())?
        .unwrap_or_else(|| display_name.to_owned());

    Ok(FoundedVault {
        vault_id,
        display_name,
        file,
        data_dir: data_dir.to_path_buf(),
        capture,
        vault,
    })
}

/// `centraid pair --mint`: mint one ticket, print it, exit.
///
/// Without `--mint` there is nothing to do and the usage code says so rather
/// than a zero exit on no work.
pub async fn pair_mint(
    mint: bool,
    data_dir: Option<PathBuf>,
    vault_name: String,
    no_relay: bool,
) -> u8 {
    if !mint {
        eprintln!(
            "centraid: `pair` needs `--mint` (or use `centraid seat pair <ticket>` to redeem one)."
        );
        return exit::USAGE;
    }
    let _ = data_dir;
    let config = EndpointConfig {
        relay: relay_mode(None, no_relay),
        ..EndpointConfig::default()
    };
    let endpoint = match Endpoint::spawn(config).await {
        Ok(endpoint) => endpoint,
        Err(error) => {
            eprintln!("centraid: the endpoint would not bind: {error}");
            return exit::REFUSED;
        }
    };
    let allowlist = MemoryAllowlist::new();
    let minted = match pairing::mint(&endpoint, &allowlist, &vault_name, now_ms()).await {
        Ok(minted) => minted,
        Err(error) => {
            eprintln!("centraid: could not mint a pair ticket: {error}");
            return exit::REFUSED;
        }
    };
    print_ticket(&minted.encoded);
    eprintln!(
        "centraid: this ticket was minted by a process that is about to exit, so nothing can \
         redeem it. Run `centraid gateway --print-qr` for a ticket a device can use \
         (that gateway keeps its enrolments in its vault, D-1025-S7-8x)."
    );
    endpoint.close().await;
    exit::OK
}

/// `centraid seat pair <ticket>`: redeem a ticket against its gateway.
pub async fn seat_pair(encoded: &str) -> u8 {
    let Some(scanned) = ticket::decode(encoded) else {
        eprintln!(
            "centraid: that is not a v{} pair ticket. Scan the QR again, or copy the whole line \
             the gateway printed.",
            ticket::TICKET_VERSION
        );
        return exit::REFUSED;
    };
    if ticket::is_expired(&scanned, now_ms()) {
        eprintln!("centraid: that ticket has expired. Ask the gateway for a new one.");
        return exit::REFUSED;
    }

    let endpoint = match Endpoint::spawn(EndpointConfig::default()).await {
        Ok(endpoint) => endpoint,
        Err(error) => {
            eprintln!("centraid: the endpoint would not bind: {error}");
            return exit::REFUSED;
        }
    };
    let platform = std::env::consts::OS;
    let name = hostname().unwrap_or_else(|| format!("a {platform} seat"));
    let outcome = pairing::redeem(&endpoint, &scanned, &name, platform).await;
    endpoint.close().await;

    use centraid_api_proto::core_v1::pair_response;
    match outcome {
        // THE CONNECTION IS DROPPED HERE, deliberately. `redeem` hands it back
        // so a seat can bootstrap on the connection it just paired on
        // (D-1025-S3-4); this verb's whole job is the enrolment, and the
        // replica it would fetch belongs to `centraid seat`.
        Ok((_connection, response)) => match response.result {
            Some(pair_response::Result::Ok(ok)) => {
                println!("paired vault={} device={}", ok.vault_name, ok.device_id);
                eprintln!(
                    "centraid: the enrolment is recorded on the gateway. The replica itself lands \
                     in wave 2 lane D2, so this seat holds no rows yet."
                );
                exit::OK
            }
            Some(pair_response::Result::Error(error)) => {
                eprintln!(
                    "centraid: the gateway refused the ticket: {:?}",
                    error.code()
                );
                exit::REFUSED
            }
            None => {
                eprintln!("centraid: the gateway answered with no result.");
                exit::REFUSED
            }
        },
        Err(error) => {
            eprintln!("centraid: {error}");
            exit::REFUSED
        }
    }
}

/// The ticket, then its QR. The string comes FIRST and on stdout, because a
/// member on a phone scans and a member on an ssh session copies — and a QR
/// that scrolled the string out of the buffer serves only the first.
fn print_ticket(encoded: &str) {
    println!("ticket {encoded}");
    match ticket::qr(encoded) {
        Ok(rendered) => println!("{rendered}"),
        Err(error) => eprintln!("centraid: the ticket would not render as a QR: {error}"),
    }
}

fn hex(bytes: &[u8]) -> String {
    centraid_net::allowlist::hex_lower(bytes)
}

fn hostname() -> Option<String> {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_relay_flags_resolve_in_one_place() {
        assert_eq!(relay_mode(None, false), RelayMode::Default);
        assert_eq!(relay_mode(None, true), RelayMode::Disabled);
        assert_eq!(
            relay_mode(Some("https://relay.example".to_owned()), false),
            RelayMode::Custom("https://relay.example".to_owned())
        );
        // `--no-relay` wins over `--relay`, and clap refuses the combination
        // anyway; the belt and the braces disagreeing is the failure worth
        // ruling out.
        assert_eq!(
            relay_mode(Some("https://relay.example".to_owned()), true),
            RelayMode::Disabled
        );
    }

    /// An unimplemented verb exits 3, never 0. The whole point of
    /// D-1020-C11 in one assertion.
    #[test]
    fn an_unavailable_verb_exits_three() {
        assert_eq!(not_yet_available("recover", "wave 2 lane R"), 3);
        assert_ne!(not_yet_available("recover", "wave 2 lane R"), exit::OK);
    }

    #[tokio::test]
    async fn pair_without_mint_is_a_usage_error_rather_than_silent_success() {
        assert_eq!(
            pair_mint(false, None, "Home".to_owned(), true).await,
            exit::USAGE
        );
    }

    /// A malformed or expired ticket is refused before any endpoint is bound,
    /// so a mistyped paste costs no socket.
    #[tokio::test]
    async fn a_bad_ticket_is_refused_without_touching_the_network() {
        assert_eq!(seat_pair("not a ticket").await, exit::REFUSED);
        assert_eq!(seat_pair("").await, exit::REFUSED);
    }

    #[test]
    fn the_exit_codes_are_distinct_and_zero_means_it_worked() {
        let codes = [
            exit::OK,
            exit::REFUSED,
            exit::USAGE,
            exit::NOT_YET_AVAILABLE,
        ];
        assert_eq!(codes, [0, 1, 2, 3]);
        for (index, code) in codes.iter().enumerate() {
            for (other_index, other) in codes.iter().enumerate() {
                if index != other_index {
                    assert_ne!(code, other);
                }
            }
        }
    }
}
