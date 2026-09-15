//! The transport seam (#1020, D-1020-C1).
//!
//! **No iroh type appears in this crate.** That is the whole design: the
//! protocol is written over `tokio::io::{AsyncRead, AsyncWrite}` and the two
//! traits below, `crates/net` implements them over iroh 1.x, and lane D2's
//! `turmoil` simulation implements them over turmoil's streams. Deterministic
//! simulation is #1020's primary sync proof, and a protocol that named iroh
//! could not be simulated — it would need a real network to be tested at all,
//! which is exactly the position v0 was in across Bun, Hermes and a browser
//! worker.
//!
//! The traits use `impl Future` in return position rather than `async fn` in a
//! `dyn`-compatible shape, because nothing here needs a trait object: the seat,
//! the gateway and the simulation each pick one implementation at compile time,
//! and paying a vtable plus a box per stream for a choice made once is the
//! wrong trade on a phone.

use std::future::Future;

use tokio::io::{AsyncRead, AsyncWrite};

use crate::error::Result;

/// One end of an established connection. Streams are opened on it, not on the
/// transport, because a connection has identity (a peer, a negotiated ALPN)
/// that every stream inherits.
pub trait Connection: Send + Sync {
    type Send: AsyncWrite + Send + Unpin + 'static;
    type Recv: AsyncRead + Send + Unpin + 'static;

    /// Open a bidirectional stream. The caller writes the first frame; the
    /// peer's `accept_bi` returns once that frame's bytes arrive, which is how
    /// QUIC reports a new stream and is therefore the contract a simulation
    /// must reproduce.
    fn open_bi(&self) -> impl Future<Output = Result<(Self::Send, Self::Recv)>> + Send;

    /// Accept a bidirectional stream the peer opened.
    fn accept_bi(&self) -> impl Future<Output = Result<(Self::Send, Self::Recv)>> + Send;

    /// The peer's identity as bytes — an iroh EndpointId in `crates/net`, an
    /// address in the simulation. Opaque here: the protocol never interprets
    /// it, it only passes it to the allowlist, which is what keeps authority
    /// out of this crate.
    fn peer(&self) -> Vec<u8>;
}

/// Something that makes connections.
pub trait Transport: Send + Sync {
    type Conn: Connection;

    /// Dial `peer` on `alpn`. **Bounded**: an implementation must have a
    /// timeout and must never hang (#1020, D-1020-C9).
    fn connect(
        &self,
        peer: &[u8],
        alpn: &'static [u8],
    ) -> impl Future<Output = Result<Self::Conn>> + Send;

    /// Accept the next inbound connection.
    fn accept(&self) -> impl Future<Output = Result<Self::Conn>> + Send;
}

#[cfg(test)]
pub(crate) mod duplex {
    //! A `Connection` over `tokio::io::duplex`, for this crate's own tests.
    //!
    //! It exists so the protocol's tests need no transport at all: the seam
    //! above is not tested by mocking iroh, it is tested by there being a second
    //! implementation. If the trait only ever had one implementor, the claim
    //! that it is transport-generic would be untested.

    use std::sync::Mutex;
    use std::sync::mpsc;

    use tokio::io::{DuplexStream, duplex};

    use super::{Connection, Result};

    pub struct Pair {
        pub left: Endpoint,
        pub right: Endpoint,
    }

    pub struct Endpoint {
        peer: Vec<u8>,
        /// Streams this end opens are handed to the other end's queue.
        outbound: Mutex<mpsc::Sender<DuplexStream>>,
        inbound: Mutex<mpsc::Receiver<DuplexStream>>,
    }

    /// Two ends that can open streams to each other.
    pub fn pair() -> Pair {
        let (to_right, from_left) = mpsc::channel();
        let (to_left, from_right) = mpsc::channel();
        Pair {
            left: Endpoint {
                peer: b"right".to_vec(),
                outbound: Mutex::new(to_right),
                inbound: Mutex::new(from_right),
            },
            right: Endpoint {
                peer: b"left".to_vec(),
                outbound: Mutex::new(to_left),
                inbound: Mutex::new(from_left),
            },
        }
    }

    impl Connection for Endpoint {
        type Send = tokio::io::WriteHalf<DuplexStream>;
        type Recv = tokio::io::ReadHalf<DuplexStream>;

        async fn open_bi(&self) -> Result<(Self::Send, Self::Recv)> {
            let (mine, theirs) = duplex(64 * 1024);
            self.outbound
                .lock()
                .expect("the duplex sender")
                .send(theirs)
                .expect("the peer end is alive");
            let (recv, send) = tokio::io::split(mine);
            Ok((send, recv))
        }

        async fn accept_bi(&self) -> Result<(Self::Send, Self::Recv)> {
            let stream = self
                .inbound
                .lock()
                .expect("the duplex receiver")
                .recv()
                .expect("a stream was opened");
            let (recv, send) = tokio::io::split(stream);
            Ok((send, recv))
        }

        fn peer(&self) -> Vec<u8> {
            self.peer.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing::{read_frame, write_frame};

    /// The seam has a second implementation and the protocol runs over it. This
    /// is what makes D-1020-C1's claim testable at all.
    #[tokio::test]
    async fn the_protocol_runs_over_a_transport_that_is_not_iroh() {
        let pair = duplex::pair();
        let (mut send, _recv) = pair.left.open_bi().await.expect("open");
        let (_their_send, mut their_recv) = pair.right.accept_bi().await.expect("accept");

        write_frame(&mut send, b"a commit").await.expect("write");
        let body = read_frame(&mut their_recv)
            .await
            .expect("read")
            .expect("a frame");
        assert_eq!(body, b"a commit");
        assert_eq!(pair.left.peer(), b"right");
        assert_eq!(pair.right.peer(), b"left");
    }
}
