//! `centraid seat` — the seat process the desktop owns (#1020, D-1020-F1).
//!
//! One process, one socket, one window. Lane C left this verb exiting 3 and
//! lane D2 built the replica plane it stands on (`crates/seat`); what lands
//! here is the **door**: a local socket, a peer check, the statement
//! catalogue, the blob range reader, and the four states.
//!
//! ```text
//! centraid seat --data-dir <dir> --socket <path> [--nonce-file <path>] [--thin]
//! ```
//!
//! ## Two modes, one API (D-1020-F4)
//!
//! `--thin` opens `crates/core` as `Role::Seat { kind: Thin }`, which forwards
//! every call the local file cannot answer and answers `Unavailable` when the
//! gateway cannot be reached. Without it the seat is `Replicated`: a full local
//! mirror that reads offline. **The socket surface is identical** — that is the
//! whole claim, and the renderer does not branch on it. What differs is what
//! the four states say, and the shell draws that.
//!
//! The thin *forwarding* itself is `crates/core`'s (D2's `dispatch` refuses
//! non-local requests with `Unavailable` until the gateway is dialled, which is
//! wave 4's lane); this verb chooses the role and reports the state honestly
//! rather than claiming a forward that does not happen yet. The receipt says so
//! in those words.
//!
//! ## Who may connect
//!
//! Three local client kinds, one credential (the socket) plus one binding:
//! the shell proves the **instance nonce**, and `centraid mcp` and
//! `centraid native-host` present a **per-turn capability token** the shell
//! minted for them (D-1020-AS2). `desktop/README.md` states the contract.

pub mod blob;
pub mod catalogue;
pub mod core_link;
pub mod local;
pub mod locker;
pub mod peer;
pub mod server;
pub mod state;

use std::path::PathBuf;
use std::sync::Arc;

use centraid_core::{CoreConfig, Role, SeatKind};

use crate::exit;
use blob::BlobPaths;
use local::SeatMode;

pub struct SeatArgs {
    pub data_dir: Option<PathBuf>,
    /// Where the local socket lives. Without it there is no door, and the verb
    /// says so rather than running a seat nothing can reach.
    pub socket: Option<PathBuf>,
    /// The file holding the instance nonce.
    ///
    /// A FILE AND NEVER A FLAG: a flag is in the shell history and in every
    /// `ps` listing on the host — the same rule `--password-file` follows
    /// (`main.rs`'s `Recover`). `CENTRAID_SEAT_NONCE` is accepted as a
    /// fallback because an env var is at least only readable by this uid.
    pub nonce_file: Option<PathBuf>,
    pub thin: bool,
    /// Print the statement catalogue as JSON and exit. What
    /// `contracts/desktop/socket-catalogue.json` is checked against.
    pub print_catalogue: bool,
}

/// Run the seat until a client terminates it or the process is signalled.
pub async fn run(args: SeatArgs) -> u8 {
    if args.print_catalogue {
        print_catalogue();
        return exit::OK;
    }
    let Some(socket) = args.socket else {
        eprintln!(
            "centraid: `seat` needs `--socket <path>`: a seat serves one local socket and has no \
             other door. The desktop passes `<userData>/seat.sock`."
        );
        return exit::USAGE;
    };
    #[cfg(not(unix))]
    {
        let _ = socket;
        eprintln!(
            "centraid: the seat socket is a Unix domain socket. The Windows door is a named pipe \
             with a DACL for the current user, and it is an owner hand-off (#1020 lane F): there \
             is no Windows machine in this lane, and a pipe whose DACL was written but never \
             observed to refuse anybody is a claim rather than a protection."
        );
        return exit::NOT_YET_AVAILABLE;
    }
    #[cfg(unix)]
    {
        let Some(data_dir) = args.data_dir else {
            eprintln!(
                "centraid: `seat` needs `--data-dir <dir>`: a seat reads a vault file, and a seat \
                 with no file would answer every read with an empty list."
            );
            return exit::USAGE;
        };
        let vault = match crate::cmd::sole_vault_file(&data_dir) {
            Ok(file) => file,
            Err(why) => {
                eprintln!("centraid: {why}");
                eprintln!(
                    "centraid: redeem a pair ticket with `centraid seat pair <ticket>` and install \
                     a snapshot before running a seat over this directory."
                );
                return exit::REFUSED;
            }
        };
        let mode = if args.thin {
            SeatMode::Thin
        } else {
            SeatMode::Replicated
        };
        let instance = match instance_nonce(args.nonce_file.as_deref()) {
            Ok(nonce) => nonce,
            Err(why) => {
                eprintln!("centraid: {why}");
                return exit::USAGE;
            }
        };

        let listener = match server::bind(&socket, &instance).await {
            Ok(Some(listener)) => listener,
            Ok(None) => {
                // ADOPTED. A second launch of the shell is harmless and says so.
                println!("{READY_LINE} adopted socket={}", socket.display());
                eprintln!(
                    "centraid: a seat for this install is already serving {} — nothing to do.",
                    socket.display()
                );
                return exit::OK;
            }
            Err(why) => {
                eprintln!("centraid: {why}");
                return exit::REFUSED;
            }
        };

        // THE GATEWAY THIS SEAT IS PAIRED TO is not known to this verb yet: the
        // durable allowlist and the seat's own pairing record land with the
        // gateway dial (wave 4). An empty endpoint id is honest — the role is
        // still the role, and the four states report `Unconfigured` rather
        // than pretending a link exists.
        let role = Role::Seat {
            kind: if args.thin {
                SeatKind::Thin
            } else {
                SeatKind::Replicated
            },
            gateway: Vec::new(),
        };
        let config = CoreConfig {
            role,
            // A seat NEVER founds a vault: the file it expects is the snapshot
            // it installed, and a fresh empty one would be a silently empty
            // product (`crates/core/src/config.rs`'s `create` field).
            create: false,
            ..CoreConfig::gateway(&vault)
        };
        let core = match core_link::CoreLink::open(config).await {
            Ok(core) => core,
            Err(why) => {
                eprintln!(
                    "centraid: the core would not open {}: {why}",
                    vault.display()
                );
                return exit::REFUSED;
            }
        };
        // THE VAULT'S OWN ID, read once at startup, because the Locker
        // passphrase wrap binds it (D-1020-L4, D-1020-X6). A seat that could
        // not read it still serves every other app: the Locker plane simply has
        // nothing to wrap against and reports `NotEnrolled`.
        let vault_id = server::vault_id_of(&core).await.unwrap_or_default();
        let seat = Arc::new(server::Seat::new(
            instance,
            mode,
            BlobPaths::new(crate::cmd::blobs_dir_in(&data_dir)),
            core,
            locker::LockerPlane::new(&data_dir, &vault_id),
        ));

        // The line the shell's supervisor waits for. A fixed prefix on stdout,
        // for the same reason the gateway has one: a test and a spawn wrapper
        // both need to know the door is open, and "grep the log for something
        // that looks right" is not a contract.
        println!(
            "{READY_LINE} socket={} mode={}",
            socket.display(),
            if args.thin { "thin" } else { "replicated" }
        );

        let serving = {
            let seat = seat.clone();
            tokio::spawn(async move { server::serve(listener, seat).await })
        };
        tokio::select! {
            _ = &mut Box::pin(tokio::signal::ctrl_c()) => {
                tracing::info!("shutting down on a signal");
                // THE SAME CLOSE THE TERMINAL COMMAND TAKES. A signalled seat
                // and a terminated seat must land the vault's last write the
                // same way, or `SIGTERM` becomes a data-loss path.
                seat.core.close().await;
            }
            joined = serving => {
                if let Err(error) = joined {
                    tracing::error!(%error, "the accept loop stopped");
                }
            }
        }
        // The socket file is this process's to remove: it bound it, and the
        // next launch's stale-file probe is cheaper than leaving one behind.
        let _ = std::fs::remove_file(&socket);
        exit::OK
    }
}

/// The line a supervisor waits for.
pub const READY_LINE: &str = "centraid seat ready";

/// Read the instance nonce, or say why there is none.
fn instance_nonce(nonce_file: Option<&std::path::Path>) -> Result<String, String> {
    if let Some(path) = nonce_file {
        let text = std::fs::read_to_string(path)
            .map_err(|error| format!("reading the nonce from {}: {error}", path.display()))?;
        let nonce = text.trim().to_owned();
        if nonce.is_empty() {
            return Err(format!("{} holds no nonce", path.display()));
        }
        return Ok(nonce);
    }
    match std::env::var("CENTRAID_SEAT_NONCE") {
        Ok(nonce) if !nonce.trim().is_empty() => Ok(nonce.trim().to_owned()),
        _ => Err(
            "`seat` needs an instance nonce: pass `--nonce-file <path>` or set \
             `CENTRAID_SEAT_NONCE`. Without one, any local process of this uid could attach as \
             the shell and there would be nothing for an adoption probe to compare."
                .to_owned(),
        ),
    }
}

/// Print the catalogue as the JSON `contracts/desktop/socket-catalogue.json`
/// pins.
fn print_catalogue() {
    let listed: Vec<serde_json::Value> = catalogue::catalogue()
        .into_iter()
        .map(|(name, query)| {
            let wired = catalogue::to_wire(&query);
            let order = wired.order.unwrap_or_default();
            serde_json::json!({
                "name": name,
                "statement": wired.name,
                "select": wired.select,
                "from": wired.from,
                "where": wired.r#where,
                "binds": wired.bind.len(),
                "sort_column": order.sort_column,
                "pk_column": order.pk_column,
                "descending": order.descending,
            })
        })
        .collect();
    let document = serde_json::json!({
        "local_protocol_version": local::LOCAL_PROTOCOL_VERSION,
        "statements": listed,
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&document).unwrap_or_else(|_| "{}".to_owned())
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_seat_with_no_nonce_says_what_to_pass_rather_than_inventing_one() {
        // The env fallback is not set in a test process, so this is the refusal.
        let error = instance_nonce(None).expect_err("refused");
        assert!(error.contains("--nonce-file"), "{error}");
    }

    #[test]
    fn a_nonce_file_is_read_and_trimmed_and_an_empty_one_is_refused() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let path = dir.path().join("nonce");
        std::fs::write(&path, "  abc123\n").expect("a nonce");
        assert_eq!(instance_nonce(Some(&path)).expect("read"), "abc123");
        std::fs::write(&path, "   \n").expect("an empty nonce");
        assert!(instance_nonce(Some(&path)).is_err());
        assert!(instance_nonce(Some(&dir.path().join("absent"))).is_err());
    }

    #[tokio::test]
    async fn the_verb_refuses_without_a_socket_rather_than_serving_nothing() {
        let code = run(SeatArgs {
            data_dir: None,
            socket: None,
            nonce_file: None,
            thin: false,
            print_catalogue: false,
        })
        .await;
        assert_eq!(code, exit::USAGE);
    }

    #[tokio::test]
    async fn the_verb_refuses_a_data_directory_with_no_vault() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let nonce = dir.path().join("nonce");
        std::fs::write(&nonce, "abc").expect("a nonce");
        let code = run(SeatArgs {
            data_dir: Some(dir.path().to_path_buf()),
            socket: Some(dir.path().join("seat.sock")),
            nonce_file: Some(nonce),
            thin: false,
            print_catalogue: false,
        })
        .await;
        // REFUSED, not 0: a seat over an empty directory would answer every
        // read with an empty list, which is the three-state read law's exact
        // failure.
        assert_eq!(code, exit::REFUSED);
    }

    #[tokio::test]
    async fn printing_the_catalogue_exits_zero_and_needs_nothing_else() {
        let code = run(SeatArgs {
            data_dir: None,
            socket: None,
            nonce_file: None,
            thin: false,
            print_catalogue: true,
        })
        .await;
        assert_eq!(code, exit::OK);
    }
}
