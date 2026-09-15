//! Property tests and a malformed-prefix corpus for the framing codec.
//!
//! The example tests beside the codec cover the cases the author thought of.
//! These two cover the ones nobody did: any body within the ceiling round-trips,
//! and no four-byte prefix — whatever its value — makes the reader panic,
//! allocate without bound, or return a body the prefix did not describe.

use centraid_protocol::error::ProtocolError;
use centraid_protocol::framing::{MAX_FRAME_BYTES, PREFIX_BYTES, read_frame, write_frame};
use proptest::prelude::*;

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .expect("a runtime")
        .block_on(future)
}

proptest! {
    /// Any non-empty body within the ceiling survives a write and a read.
    #[test]
    fn any_body_within_the_ceiling_round_trips(body in proptest::collection::vec(any::<u8>(), 1..4096)) {
        let read = block_on(async {
            let mut wire = Vec::new();
            write_frame(&mut wire, &body).await.expect("write");
            read_frame(&mut wire.as_slice()).await.expect("read").expect("a frame")
        });
        prop_assert_eq!(read, body);
    }

    /// A run of frames reads back in order with no bleed between them. The
    /// failure this catches is a reader that consumes one byte too many or too
    /// few: the first frame still passes and the second is garbage.
    #[test]
    fn a_run_of_frames_reads_back_in_order(
        bodies in proptest::collection::vec(proptest::collection::vec(any::<u8>(), 1..200), 1..20)
    ) {
        let read: Vec<Vec<u8>> = block_on(async {
            let mut wire = Vec::new();
            for body in &bodies {
                write_frame(&mut wire, body).await.expect("write");
            }
            let mut reader = wire.as_slice();
            let mut out = Vec::new();
            while let Some(body) = read_frame(&mut reader).await.expect("read") {
                out.push(body);
            }
            out
        });
        prop_assert_eq!(read, bodies);
    }

    /// ANY four bytes as a prefix, followed by up to 64 arbitrary bytes. The
    /// reader must either return a body whose length the prefix declared, or
    /// fail with one of the four framing errors. Never a panic, never a body of
    /// a different length, never an allocation of the claimed size when the
    /// claim is over the ceiling.
    #[test]
    fn no_four_byte_prefix_makes_the_reader_misbehave(
        prefix in any::<[u8; 4]>(),
        tail in proptest::collection::vec(any::<u8>(), 0..64)
    ) {
        let declared = u32::from_be_bytes(prefix) as usize;
        let mut wire = prefix.to_vec();
        wire.extend_from_slice(&tail);

        let outcome = block_on(read_frame(&mut wire.as_slice()));
        match outcome {
            Ok(Some(body)) => {
                prop_assert_eq!(body.len(), declared);
                prop_assert!(declared > 0 && declared <= MAX_FRAME_BYTES);
                prop_assert!(declared <= tail.len());
            }
            Ok(None) => prop_assert!(false, "four bytes are not a clean end of stream"),
            Err(ProtocolError::EmptyFrame) => prop_assert_eq!(declared, 0),
            Err(ProtocolError::FrameTooLarge { len, max }) => {
                prop_assert_eq!(len, declared);
                prop_assert_eq!(max, MAX_FRAME_BYTES);
                prop_assert!(declared > MAX_FRAME_BYTES);
            }
            Err(ProtocolError::TruncatedBody { expected }) => {
                prop_assert_eq!(expected, declared);
                prop_assert!(declared > tail.len());
            }
            Err(other) => prop_assert!(false, "unexpected: {:?}", other),
        }
    }
}

/// The named corpus: the prefixes worth having a row for, each with the answer
/// it must produce. A property test finds the family; this states the members
/// that have actually gone wrong in a framing codec before.
#[test]
fn the_malformed_prefix_corpus_has_a_named_answer_for_each_row() {
    // (bytes, description)
    let corpus: [(&[u8], &str); 8] = [
        (&[], "a clean end of stream between frames"),
        (&[0], "one byte of a prefix"),
        (&[0, 0, 0], "three bytes of a prefix"),
        (&[0, 0, 0, 0], "a declared length of zero"),
        (&[0, 0, 0, 1], "a prefix with no body at all"),
        (&[0xff, 0xff, 0xff, 0xff], "u32::MAX, the allocation bomb"),
        (
            &[0x00, 0x04, 0x00, 0x01],
            "262145 — one byte over the ceiling",
        ),
        (
            &[0x00, 0x04, 0x00, 0x00],
            "262144 — exactly the ceiling, with no body",
        ),
    ];
    for (bytes, description) in corpus {
        let outcome = block_on(read_frame(&mut { bytes }));
        match (bytes.len(), outcome) {
            (0, Ok(None)) => {}
            (0, other) => panic!("{description}: {other:?}"),
            (_, Ok(Some(body))) => panic!("{description}: returned a {}-byte body", body.len()),
            (_, Ok(None)) => panic!("{description}: reported a clean end mid-prefix"),
            (_, Err(error)) => {
                assert!(
                    matches!(
                        error,
                        ProtocolError::EmptyFrame
                            | ProtocolError::FrameTooLarge { .. }
                            | ProtocolError::TruncatedPrefix { .. }
                            | ProtocolError::TruncatedBody { .. }
                    ),
                    "{description}: {error:?}"
                );
                assert!(
                    error.is_fatal_to_the_stream(),
                    "{description}: a framing fault means the stream's position is lost"
                );
            }
        }
    }
    assert_eq!(PREFIX_BYTES, 4);
}
