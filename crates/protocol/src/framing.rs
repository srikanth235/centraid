//! One framing, for every stream (#1020, D-1020-C2).
//!
//! `u32BE(len) ‖ bytes`, and nothing else. v0 framed a JSON header the same way
//! (`encodeHeaderFrame`, `packages/tunnel/src/protocol.ts:139-145`) with the
//! same 256 KiB ceiling, so the bound below is not a new number — it is v0's,
//! kept because it is the one that has been run against real phones.
//!
//! Three refusals, each of which was reachable in v0 and is a test here:
//!
//! * `len == 0` is a refusal, not an empty message. An empty `Envelope` encodes
//!   to zero bytes, so a zero prefix and "a message with every field at its
//!   default" would be the same bytes on the wire — and then a stream of zeroes
//!   is an infinite sequence of valid frames. v0 rejects `len === 0` for the
//!   same reason (`protocol.ts:156-164`).
//! * `len > MAX_FRAME_BYTES` is a refusal BEFORE any allocation. A length
//!   prefix is attacker-controlled on any connection that has not finished the
//!   handshake, and `Vec::with_capacity(len)` on a claimed 4 GiB is the whole
//!   exploit.
//! * A short read after a valid prefix is a refusal, not a partial frame. The
//!   reader either returns a whole body or an error.
//!
//! A malformed frame closes the connection. It is not a failed request: the
//! stream's position is no longer known, so there is nothing to resynchronise
//! to.

use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _};

use crate::error::{ProtocolError, Result};

/// The control-frame ceiling: 256 KiB, v0's `MAX_HEADER_FRAME_BYTES`
/// (`packages/tunnel/src/protocol.ts:82`, mirrored in Rust at
/// `packages/tunnel/data-plane/src/lib.rs:19`).
pub const MAX_FRAME_BYTES: usize = 262_144;

/// Bodies are chunked at 64 KiB — v0's `READ_CHUNK_BYTES`
/// (`packages/tunnel/src/protocol.ts:86`). A body is a sequence of frames, so
/// the ceiling above still applies to each one; this is the size a producer
/// aims for, not a second bound.
pub const CHUNK_BYTES: usize = 65_536;

/// The four bytes of the length prefix.
pub const PREFIX_BYTES: usize = 4;

/// Frame `body` onto `writer`. The prefix and the body go out in ONE write
/// call, so a reader never sees a prefix whose body is still being produced —
/// which matters because a reader that has consumed a prefix is committed to
/// the body.
pub async fn write_frame<W>(writer: &mut W, body: &[u8]) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    if body.is_empty() {
        return Err(ProtocolError::EmptyFrame);
    }
    if body.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            len: body.len(),
            max: MAX_FRAME_BYTES,
        });
    }
    let mut out = Vec::with_capacity(PREFIX_BYTES + body.len());
    out.extend_from_slice(
        &u32::try_from(body.len())
            .expect("bounded above")
            .to_be_bytes(),
    );
    out.extend_from_slice(body);
    writer.write_all(&out).await?;
    Ok(())
}

/// Read one frame's body from `reader`.
///
/// `Ok(None)` is a clean end of stream — the peer closed between frames, which
/// is how a connection is supposed to end. A close mid-frame is an error.
pub async fn read_frame<R>(reader: &mut R) -> Result<Option<Vec<u8>>>
where
    R: AsyncRead + Unpin,
{
    let mut prefix = [0u8; PREFIX_BYTES];
    let mut filled = 0usize;
    while filled < PREFIX_BYTES {
        let read = reader.read(&mut prefix[filled..]).await?;
        if read == 0 {
            if filled == 0 {
                return Ok(None);
            }
            return Err(ProtocolError::TruncatedPrefix { got: filled });
        }
        filled += read;
    }
    let len = u32::from_be_bytes(prefix) as usize;
    if len == 0 {
        return Err(ProtocolError::EmptyFrame);
    }
    if len > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            len,
            max: MAX_FRAME_BYTES,
        });
    }
    // Allocated only after the bound has been checked.
    let mut body = vec![0u8; len];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|_| ProtocolError::TruncatedBody { expected: len })?;
    Ok(Some(body))
}

/// The bytes of a frame, without a writer. The relay path and the fixtures both
/// need "what would go on the wire" as a value.
pub fn frame_bytes(body: &[u8]) -> Result<Vec<u8>> {
    if body.is_empty() {
        return Err(ProtocolError::EmptyFrame);
    }
    if body.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            len: body.len(),
            max: MAX_FRAME_BYTES,
        });
    }
    let mut out = Vec::with_capacity(PREFIX_BYTES + body.len());
    out.extend_from_slice(
        &u32::try_from(body.len())
            .expect("bounded above")
            .to_be_bytes(),
    );
    out.extend_from_slice(body);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_frame_round_trips() {
        let body = b"centraid".to_vec();
        let mut wire = Vec::new();
        write_frame(&mut wire, &body).await.expect("write");
        assert_eq!(&wire[..PREFIX_BYTES], &[0, 0, 0, 8]);
        let read = read_frame(&mut wire.as_slice())
            .await
            .expect("read")
            .expect("a frame");
        assert_eq!(read, body);
    }

    #[tokio::test]
    async fn a_clean_close_between_frames_is_not_an_error() {
        let empty: &[u8] = &[];
        assert!(
            read_frame(&mut { empty })
                .await
                .expect("a clean end")
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_zero_length_prefix_is_refused() {
        let wire: Vec<u8> = vec![0, 0, 0, 0];
        let error = read_frame(&mut wire.as_slice())
            .await
            .expect_err("zero is not an empty message");
        assert!(matches!(error, ProtocolError::EmptyFrame), "{error:?}");
    }

    /// The bound is checked BEFORE the allocation. The test claims 4 GiB and
    /// must return in constant memory; if the reader allocated first this test
    /// would be the OOM.
    #[tokio::test]
    async fn an_oversized_prefix_is_refused_before_any_allocation() {
        let wire: Vec<u8> = vec![0xff, 0xff, 0xff, 0xff];
        let error = read_frame(&mut wire.as_slice()).await.expect_err("refused");
        match error {
            ProtocolError::FrameTooLarge { len, max } => {
                assert_eq!(len, u32::MAX as usize);
                assert_eq!(max, MAX_FRAME_BYTES);
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn a_prefix_with_no_body_is_truncated_not_empty() {
        let wire: Vec<u8> = vec![0, 0, 0, 4, 1, 2];
        let error = read_frame(&mut wire.as_slice()).await.expect_err("refused");
        assert!(
            matches!(error, ProtocolError::TruncatedBody { expected: 4 }),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn a_partial_prefix_is_truncated() {
        let wire: Vec<u8> = vec![0, 0];
        let error = read_frame(&mut wire.as_slice()).await.expect_err("refused");
        assert!(
            matches!(error, ProtocolError::TruncatedPrefix { got: 2 }),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn a_frame_at_the_ceiling_passes_and_one_byte_over_does_not() {
        let at = vec![7u8; MAX_FRAME_BYTES];
        let mut wire = Vec::new();
        write_frame(&mut wire, &at).await.expect("at the ceiling");
        assert_eq!(
            read_frame(&mut wire.as_slice())
                .await
                .expect("read")
                .expect("a frame")
                .len(),
            MAX_FRAME_BYTES
        );

        let over = vec![7u8; MAX_FRAME_BYTES + 1];
        assert!(matches!(
            write_frame(&mut Vec::new(), &over).await,
            Err(ProtocolError::FrameTooLarge { .. })
        ));
    }

    #[tokio::test]
    async fn many_frames_read_back_in_order() {
        let bodies: Vec<Vec<u8>> = (1u8..=20).map(|n| vec![n; n as usize]).collect();
        let mut wire = Vec::new();
        for body in &bodies {
            write_frame(&mut wire, body).await.expect("write");
        }
        let mut reader = wire.as_slice();
        for body in &bodies {
            assert_eq!(
                read_frame(&mut reader)
                    .await
                    .expect("read")
                    .expect("a frame"),
                *body
            );
        }
        assert!(read_frame(&mut reader).await.expect("end").is_none());
    }
}
