// The device/peer lane split, extracted from iroh_relay.rs for the repo's
// 625-line cap. Nothing here touches I/O — it names the lanes and the one
// path-confinement rule the peer lane is admitted under.

use crate::PEER_PLANE_PREFIX;

/// Which lane a connection arrived on. The lanes share framing and forwarding
/// and NOTHING else: separate admission decisions, separate injected identity
/// headers, and — for `Peer` — a hard path confinement (issue #726 P3).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Plane {
    Device,
    Peer,
}

impl Plane {
    /// Control-plane route that decides admission for this lane. The device
    /// route answers device-pairing enrollment; the peer route answers "is
    /// this endpoint a known, non-revoked LINK". Never interchange them.
    pub(crate) fn authorize_path(self) -> &'static str {
        match self {
            Plane::Device => "/centraid/_gateway/tunnel/authorize",
            Plane::Peer => "/centraid/_gateway/tunnel/peer-authorize",
        }
    }
}

/// TRAP 1 (issue #726 P3). `header.target` is peer-supplied and is pasted onto
/// `upstream_url` in `serve_stream`, so without this a link addresses the whole
/// local gateway surface — `/centraid/_gateway/*` included. Loosening this
/// function is a privilege escalation, not a relaxation.
///
/// Byte-identical to `protocol.ts::isPeerPlaneTarget`:
///   - must EXTEND the prefix (a bare prefix names no resource);
///   - the path (before `?`/`#`) carries no `%`, no `\`, and no byte <= 0x20,
///     so no normalisation step is needed to reason about it;
///   - no `.` / `..` segment.
pub(crate) fn peer_target_allowed(target: &str) -> bool {
    if target.len() <= PEER_PLANE_PREFIX.len() || !target.starts_with(PEER_PLANE_PREFIX) {
        return false;
    }
    let path = target
        .split(['?', '#'])
        .next()
        .expect("split always yields a first element");
    if path
        .bytes()
        .any(|byte| byte == b'%' || byte == b'\\' || byte <= 0x20)
    {
        return false;
    }
    path.split('/')
        .all(|segment| segment != "." && segment != "..")
}
