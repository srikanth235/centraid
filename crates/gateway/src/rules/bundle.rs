//! The bundle: many objects in one body, both directions (#1080).
//!
//! A restore pulls every derivative of a library — tens of thousands of small
//! objects — and one request per object would be a round trip each. `POST
//! bundle` uploads many objects in one body and `POST fetch` answers many in
//! one, in the same framing.
//!
//! # FORMAT DECISION — THE FRAMING
//!
//! ```text
//! frame  = name (64 ascii, lowercase hex) ‖ digest (64 ascii, lowercase hex)
//!          ‖ u64be(len) ‖ len bytes
//! bundle = frame*        nothing between frames, nothing after the last
//! ```
//!
//! A 136-byte header per frame, the digest being BLAKE3 of the frame's bytes.
//! The whole body is at most [`MAX_BUNDLE_BYTES`]. ASCII hex rather than raw
//! bytes for the two identifiers so a body is greppable in a capture, at a
//! cost of 64 bytes a frame.
//!
//! # WHY AN INCREMENTAL DECODER
//!
//! A 256 MiB body is not held in memory on either end. [`Decoder::step`] eats
//! whatever slice of the body has arrived and reports one [`Step`] at a time —
//! a header, a run of a frame's bytes, the end of a frame — so the gateway
//! streams each frame into its own staged file. It is pure: no I/O, and the
//! same decoder reads a `fetch` answer on the phone.

use crate::rules::code::Refusal;
use crate::rules::ids::{Digest, Name};
use crate::rules::limits::MAX_BUNDLE_BYTES;

/// The bytes before each frame's body.
pub const HEADER_LEN: usize = 64 + 64 + 8;

/// One frame's header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    pub name: Name,
    pub digest: Digest,
    pub len: u64,
}

/// One whole frame.
#[derive(Clone, PartialEq, Eq)]
pub struct Frame {
    pub name: Name,
    pub digest: Digest,
    pub bytes: Vec<u8>,
}

impl core::fmt::Debug for Frame {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("Frame")
            .field("name", &self.name)
            .field("digest", &self.digest)
            .field("len", &self.bytes.len())
            .finish()
    }
}

impl Frame {
    /// A frame over `bytes`, its digest computed.
    #[must_use]
    pub fn of(name: Name, bytes: Vec<u8>) -> Self {
        Self {
            name,
            digest: Digest::of(&bytes),
            bytes,
        }
    }
}

/// The header for one frame.
#[must_use]
pub fn header(name: &Name, digest: &Digest, len: u64) -> [u8; HEADER_LEN] {
    let mut out = [0_u8; HEADER_LEN];
    out[..64].copy_from_slice(name.hex().as_bytes());
    out[64..128].copy_from_slice(digest.hex().as_bytes());
    out[128..].copy_from_slice(&len.to_be_bytes());
    out
}

/// Read one header.
///
/// # Errors
///
/// `BAD_REQUEST` when either identifier is not 64 lowercase hex characters.
pub fn parse_header(bytes: &[u8; HEADER_LEN]) -> Result<FrameHeader, Refusal> {
    let text = |range: core::ops::Range<usize>| {
        core::str::from_utf8(&bytes[range]).map_err(|_| Refusal::BadRequest)
    };
    let mut len = [0_u8; 8];
    len.copy_from_slice(&bytes[128..]);
    Ok(FrameHeader {
        name: text(0..64)?.parse().map_err(|_| Refusal::BadRequest)?,
        digest: text(64..128)?.parse().map_err(|_| Refusal::BadRequest)?,
        len: u64::from_be_bytes(len),
    })
}

/// A whole bundle, in memory. For tests and small bodies; the gateway
/// streams.
#[must_use]
pub fn encode(frames: &[Frame]) -> Vec<u8> {
    let mut out = Vec::new();
    for frame in frames {
        out.extend_from_slice(&header(
            &frame.name,
            &frame.digest,
            frame.bytes.len() as u64,
        ));
        out.extend_from_slice(&frame.bytes);
    }
    out
}

/// Every frame of a whole body.
///
/// # Errors
///
/// `BAD_REQUEST` for a malformed or truncated body, `TOO_LARGE` over the cap.
pub fn decode(body: &[u8]) -> Result<Vec<Frame>, Refusal> {
    let mut decoder = Decoder::new();
    let mut frames: Vec<Frame> = Vec::new();
    let mut rest = body;
    loop {
        let (step, used) = decoder.step(rest)?;
        rest = &rest[used..];
        match step {
            None => break,
            Some(Step::Header(header)) => frames.push(Frame {
                name: header.name,
                digest: header.digest,
                bytes: Vec::with_capacity(usize::try_from(header.len).unwrap_or(0)),
            }),
            Some(Step::Body(bytes)) => {
                if let Some(frame) = frames.last_mut() {
                    frame.bytes.extend_from_slice(bytes);
                }
            }
            Some(Step::End) => {}
        }
    }
    decoder.finish()?;
    Ok(frames)
}

/// One thing the decoder found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step<'a> {
    /// A frame begins.
    Header(FrameHeader),
    /// Some of the current frame's bytes, in order.
    Body(&'a [u8]),
    /// The current frame's bytes are complete.
    End,
}

/// The incremental decoder. See the module header.
#[derive(Debug, Clone)]
pub struct Decoder {
    header: [u8; HEADER_LEN],
    filled: usize,
    /// Bytes still owed by the current frame, when inside one.
    remaining: Option<u64>,
    total: u64,
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Decoder {
    /// A decoder at the start of a body.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            header: [0; HEADER_LEN],
            filled: 0,
            remaining: None,
            total: 0,
        }
    }

    /// Take one step from `input`, which is whatever of the body has arrived
    /// and not yet been consumed. Answers the step, if one completed, and how
    /// many bytes of `input` it consumed. `None` with every byte consumed
    /// means "feed me more"; call again with an empty slice after the last
    /// chunk to collect a final [`Step::End`].
    ///
    /// # Errors
    ///
    /// `BAD_REQUEST` for a malformed header, `TOO_LARGE` when the body or a
    /// frame's declared length would pass [`MAX_BUNDLE_BYTES`].
    pub fn step<'a>(&mut self, input: &'a [u8]) -> Result<(Option<Step<'a>>, usize), Refusal> {
        if let Some(remaining) = self.remaining {
            if remaining == 0 {
                self.remaining = None;
                return Ok((Some(Step::End), 0));
            }
            let take = usize::try_from(remaining)
                .unwrap_or(usize::MAX)
                .min(input.len());
            if take == 0 {
                return Ok((None, 0));
            }
            self.remaining = Some(remaining - take as u64);
            self.count(take)?;
            return Ok((Some(Step::Body(&input[..take])), take));
        }
        let take = (HEADER_LEN - self.filled).min(input.len());
        self.header[self.filled..self.filled + take].copy_from_slice(&input[..take]);
        self.filled += take;
        self.count(take)?;
        if self.filled < HEADER_LEN {
            return Ok((None, take));
        }
        self.filled = 0;
        let header = parse_header(&self.header)?;
        if header.len > MAX_BUNDLE_BYTES.saturating_sub(self.total) {
            return Err(Refusal::TooLarge {
                limit: MAX_BUNDLE_BYTES,
            });
        }
        self.remaining = Some(header.len);
        Ok((Some(Step::Header(header)), take))
    }

    /// The body ended. It must have ended between frames.
    ///
    /// # Errors
    ///
    /// `BAD_REQUEST` for a truncated header or frame.
    pub const fn finish(&self) -> Result<(), Refusal> {
        if self.filled == 0 && self.remaining.is_none() {
            Ok(())
        } else {
            Err(Refusal::BadRequest)
        }
    }

    /// Bytes consumed so far.
    #[must_use]
    pub const fn total(&self) -> u64 {
        self.total
    }

    fn count(&mut self, bytes: usize) -> Result<(), Refusal> {
        self.total = self.total.saturating_add(bytes as u64);
        if self.total > MAX_BUNDLE_BYTES {
            return Err(Refusal::TooLarge {
                limit: MAX_BUNDLE_BYTES,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames() -> Vec<Frame> {
        vec![
            Frame::of(Name::from_bytes([1; 32]), b"first".to_vec()),
            Frame::of(Name::from_bytes([2; 32]), Vec::new()),
            Frame::of(Name::from_bytes([3; 32]), vec![7; 5_000]),
        ]
    }

    #[test]
    fn a_bundle_round_trips() {
        let body = encode(&frames());
        assert_eq!(body.len(), 3 * HEADER_LEN + 5 + 5_000);
        assert_eq!(decode(&body).expect("decodes"), frames());
        assert_eq!(decode(&[]).expect("an empty bundle"), Vec::new());
    }

    /// FED ONE BYTE AT A TIME, the decoder finds the same frames: the server
    /// streams a body in whatever pieces the network delivers.
    #[test]
    fn the_decoder_does_not_care_how_the_body_is_cut() {
        let body = encode(&frames());
        let mut decoder = Decoder::new();
        let mut seen: Vec<Frame> = Vec::new();
        let mut ends = 0;
        for byte in &body {
            let mut rest = core::slice::from_ref(byte);
            loop {
                let (step, used) = decoder.step(rest).expect("steps");
                rest = &rest[used..];
                match step {
                    None => break,
                    Some(Step::Header(header)) => seen.push(Frame {
                        name: header.name,
                        digest: header.digest,
                        bytes: Vec::new(),
                    }),
                    Some(Step::Body(bytes)) => {
                        seen.last_mut()
                            .expect("a frame")
                            .bytes
                            .extend_from_slice(bytes);
                    }
                    Some(Step::End) => ends += 1,
                }
            }
        }
        while let (Some(Step::End), _) = decoder.step(&[]).expect("steps") {
            ends += 1;
        }
        decoder.finish().expect("ended between frames");
        assert_eq!(seen, frames());
        assert_eq!(ends, 3);
    }

    /// A truncated body, a malformed name and an uppercase digest are each
    /// refused, never half-read.
    #[test]
    fn a_malformed_or_truncated_bundle_is_refused() {
        let body = encode(&frames());
        assert_eq!(decode(&body[..body.len() - 1]), Err(Refusal::BadRequest));
        assert_eq!(decode(&body[..HEADER_LEN - 1]), Err(Refusal::BadRequest));
        let mut bad_name = body.clone();
        bad_name[0] = b'z';
        assert_eq!(decode(&bad_name), Err(Refusal::BadRequest));
        let mut upper = body;
        upper[64] = b'A';
        assert_eq!(decode(&upper), Err(Refusal::BadRequest));
    }

    /// A frame that declares more than the bundle can hold is refused at its
    /// header, before a byte of it is read.
    #[test]
    fn a_frame_longer_than_the_bundle_cap_is_refused_at_its_header() {
        let name = Name::from_bytes([4; 32]);
        let head = header(&name, &Digest::of(b""), MAX_BUNDLE_BYTES);
        let mut decoder = Decoder::new();
        assert_eq!(
            decoder.step(&head),
            Err(Refusal::TooLarge {
                limit: MAX_BUNDLE_BYTES
            })
        );
    }
}
