pub mod cbsf;
pub mod format;
pub mod http_plane;
pub mod iroh_relay;
mod iroh_wire;
pub mod ticket;

pub const TUNNEL_ALPN: &[u8] = b"centraid/tunnel/1";
pub const PAIR_ALPN: &[u8] = b"centraid/pair/1";
pub const GW_PAIR_ALPN: &[u8] = b"centraid/gw-pair/1";
pub const MAX_HEADER_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_REQUEST_BODY_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_OPEN_RANGE_BYTES: u64 = 4 * 1024 * 1024;
