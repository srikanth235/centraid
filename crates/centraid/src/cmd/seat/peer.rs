//! The peer-credential check and the socket file's own protections
//! (#1020, R-1020-26, D-1020-F1).
//!
//! **This has no v0 ancestor.** v0's desktop reaches its gateway over loopback
//! HTTP with a bearer token and has no peer check anywhere (census §F seam 5);
//! the token *was* the credential, which is why `SETTINGS_GET` had to strip it
//! and `GATEWAY_AUTH_GET` had to be the one door. On a Unix socket the kernel
//! already knows who connected, so the socket becomes the credential and the
//! bearer disappears — which removes the class of bug that made those two rules
//! necessary rather than restating it.
//!
//! Three protections, and each is needed on its own:
//!
//! 1. **Mode 0600 on the socket file.** Keeps another user's `connect(2)` from
//!    even reaching `accept`. Set by [`harden`] *after* bind, because a
//!    listener's mode comes from the process umask at bind time and a umask of
//!    `022` produces a world-readable socket.
//! 2. **Mode 0700 on the directory.** A socket whose parent directory another
//!    user can write is a socket another user can unlink and replace with their
//!    own, which turns the shell's next connect into a connect to them.
//! 3. **The uid check on every accepted connection.** Belt to the braces: a
//!    mode is a fact about a file at one instant, and a check at accept is a
//!    fact about the connection being served. On Linux and macOS tokio reads
//!    `SO_PEERCRED` / `getpeereid` for us, so this needs no `unsafe`.
//!
//! Windows is a **named pipe with a DACL** and is a named owner hand-off: there
//! is no Windows machine in this lane's container, and a pipe whose DACL was
//! written but never observed to refuse anybody is a claim, not a protection.
//! [`super::server::listen`] refuses to run there with that sentence rather
//! than opening an unprotected pipe.

use std::io;
use std::path::Path;

use super::local::RefusalCode;

/// What the kernel said about the other end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerIdentity {
    pub uid: u32,
    /// `None` where the platform does not report it (tokio reports pid on
    /// Linux, Android, macOS and iOS only).
    pub pid: Option<u32>,
}

/// Admit or refuse one connection, with no I/O.
///
/// The whole decision is "is this the uid that owns the seat", and it is a
/// function so the red test can name a second uid without a second user
/// account on the runner.
pub fn judge_peer(peer: PeerIdentity, owner_uid: u32) -> Result<PeerIdentity, RefusalCode> {
    if peer.uid == owner_uid {
        Ok(peer)
    } else {
        Err(RefusalCode::ForeignPeer)
    }
}

/// Tighten the socket file and its directory. Unix only.
///
/// Returns the mode actually set, so a caller can log it and a test can assert
/// it rather than trusting that the call was made.
#[cfg(unix)]
pub fn harden(socket: &Path) -> io::Result<u32> {
    use std::os::unix::fs::PermissionsExt;

    if let Some(parent) = socket.parent() {
        // 0700 and not 0755: see protection 2 in the module header.
        let mut permissions = std::fs::metadata(parent)?.permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(parent, permissions)?;
    }
    let mut permissions = std::fs::metadata(socket)?.permissions();
    permissions.set_mode(0o600);
    std::fs::set_permissions(socket, permissions)?;
    Ok(0o600)
}

/// The uid this process runs as.
///
/// Read from `/proc/self/status` on Linux and from the socket's own owner
/// elsewhere, because `libc::getuid` would mean a new dependency and an
/// `unsafe` call in a crate that forbids it. Both readings answer the same
/// question: "who owns this seat".
#[cfg(unix)]
pub fn owner_uid(socket: &Path) -> io::Result<u32> {
    use std::os::unix::fs::MetadataExt;

    // The socket was created by this process, so its owner IS this process's
    // effective uid — no parsing, no platform text format, and it is the same
    // number `SO_PEERCRED` reports for a connection from this process.
    Ok(std::fs::metadata(socket)?.uid())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_owning_uid_is_admitted_and_a_second_uid_is_refused() {
        let owner = PeerIdentity {
            uid: 1000,
            pid: Some(42),
        };
        assert_eq!(judge_peer(owner, 1000), Ok(owner));
        // THE RED: a second local user account. Simulated by number rather
        // than by creating a user, which a container cannot do, and the
        // production path feeds this exact function from `UnixStream::peer_cred`.
        assert_eq!(
            judge_peer(
                PeerIdentity {
                    uid: 1001,
                    pid: Some(43)
                },
                1000
            ),
            Err(RefusalCode::ForeignPeer)
        );
        // root is not special: a seat serves its owner, and an administrator
        // who wants the member's rows can read the file.
        assert_eq!(
            judge_peer(PeerIdentity { uid: 0, pid: None }, 1000),
            Err(RefusalCode::ForeignPeer)
        );
    }

    #[cfg(unix)]
    #[test]
    fn hardening_sets_0600_on_the_socket_and_0700_on_its_directory() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("a temp dir");
        let socket = dir.path().join("seat.sock");
        // A plain file stands in for the socket: `set_permissions` does not
        // care what kind of node it is, and binding a real socket here would
        // make this test need a runtime.
        std::fs::write(&socket, b"").expect("a file");
        // Deliberately loose first, so the assertion is about `harden` and not
        // about the umask happening to be tight.
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o666)).expect("loosen");
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o777))
            .expect("loosen the directory");

        assert_eq!(harden(&socket).expect("harden"), 0o600);
        let mode = |path: &std::path::Path| {
            std::fs::metadata(path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode(&socket), 0o600);
        assert_eq!(mode(dir.path()), 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn the_owner_uid_is_the_uid_of_the_node_this_process_made() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let socket = dir.path().join("seat.sock");
        std::fs::write(&socket, b"").expect("a file");
        let uid = owner_uid(&socket).expect("an owner");
        // Not a literal: the runner's uid is the runner's business. What is
        // asserted is that the reading agrees with the directory this process
        // also made, so the two are one account.
        use std::os::unix::fs::MetadataExt;
        assert_eq!(uid, std::fs::metadata(dir.path()).expect("meta").uid());
    }
}
