//! The handshake, on the wire (#1020, D-1020-C6).
//!
//! One exchange, at request id `0`, before any other message. The rule #1020
//! states is that a peer outside the window receives `UpgradeRequired`
//! **before** any other message, and the shape below is what makes that true
//! rather than intended: the failure path writes `UpgradeRequired` and returns
//! the error, so a caller cannot accidentally proceed — there is no handshake
//! result to carry on with.

use centraid_api_proto::core_v1::{Hello, Request, Response, request, response};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::error::{ProtocolError, Result};
use crate::version::judge;
use crate::wire::{read_envelope, request as request_envelope, response as response_envelope};
use centraid_api_proto::core_v1::envelope;

/// Request id `0`. Reserved for the handshake, which is not a request: it is
/// exchanged before any id has been minted.
pub const HANDSHAKE_REQUEST_ID: u64 = 0;

/// The dialling side. Sends `Hello`, reads the peer's, judges the window.
///
/// On refusal the peer is told with an `UpgradeRequired` response — the dialler
/// is the side that learns first, and a peer left to time out cannot render
/// "update your gateway".
pub async fn dial<W, R>(writer: &mut W, reader: &mut R, local: &Hello) -> Result<Hello>
where
    W: AsyncWrite + Unpin,
    R: AsyncRead + Unpin,
{
    crate::wire::write_envelope(
        writer,
        &request_envelope(
            HANDSHAKE_REQUEST_ID,
            Request {
                kind: Some(request::Kind::Hello(local.clone())),
            },
        ),
    )
    .await?;

    let peer = expect_hello_response(reader).await?;
    match judge(local, &peer) {
        Ok(()) => Ok(peer),
        Err(upgrade) => {
            crate::wire::write_envelope(
                writer,
                &response_envelope(
                    HANDSHAKE_REQUEST_ID,
                    Response {
                        kind: Some(response::Kind::UpgradeRequired(upgrade)),
                    },
                ),
            )
            .await?;
            Err(ProtocolError::VersionWindow(upgrade))
        }
    }
}

/// The accepting side. Reads the peer's `Hello`, judges, and answers with
/// either its own `Hello` or an `UpgradeRequired` — and NOTHING ELSE goes out
/// first.
pub async fn accept<W, R>(writer: &mut W, reader: &mut R, local: &Hello) -> Result<Hello>
where
    W: AsyncWrite + Unpin,
    R: AsyncRead + Unpin,
{
    let peer = expect_hello_request(reader).await?;
    match judge(local, &peer) {
        Ok(()) => {
            crate::wire::write_envelope(
                writer,
                &response_envelope(
                    HANDSHAKE_REQUEST_ID,
                    Response {
                        kind: Some(response::Kind::Hello(local.clone())),
                    },
                ),
            )
            .await?;
            Ok(peer)
        }
        Err(upgrade) => {
            crate::wire::write_envelope(
                writer,
                &response_envelope(
                    HANDSHAKE_REQUEST_ID,
                    Response {
                        kind: Some(response::Kind::UpgradeRequired(upgrade)),
                    },
                ),
            )
            .await?;
            Err(ProtocolError::VersionWindow(upgrade))
        }
    }
}

async fn expect_hello_request<R>(reader: &mut R) -> Result<Hello>
where
    R: AsyncRead + Unpin,
{
    let envelope = read_envelope(reader)
        .await?
        .ok_or(ProtocolError::TruncatedPrefix { got: 0 })?;
    if envelope.request_id != HANDSHAKE_REQUEST_ID {
        return Err(ProtocolError::BadRequestId(envelope.request_id));
    }
    match envelope.body {
        Some(envelope::Body::Request(Request {
            kind: Some(request::Kind::Hello(hello)),
        })) => Ok(hello),
        _ => Err(ProtocolError::UnsupportedMessage {
            type_url: "centraid.core.v1.Hello (expected first on the stream)".to_owned(),
        }),
    }
}

async fn expect_hello_response<R>(reader: &mut R) -> Result<Hello>
where
    R: AsyncRead + Unpin,
{
    let envelope = read_envelope(reader)
        .await?
        .ok_or(ProtocolError::TruncatedPrefix { got: 0 })?;
    if envelope.request_id != HANDSHAKE_REQUEST_ID {
        return Err(ProtocolError::BadRequestId(envelope.request_id));
    }
    match envelope.body {
        Some(envelope::Body::Response(Response {
            kind: Some(response::Kind::Hello(hello)),
        })) => Ok(hello),
        Some(envelope::Body::Response(Response {
            kind: Some(response::Kind::UpgradeRequired(upgrade)),
        })) => Err(ProtocolError::VersionWindow(upgrade)),
        _ => Err(ProtocolError::UnsupportedMessage {
            type_url: "centraid.core.v1.Hello (expected first on the stream)".to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::version::local_hello;
    use centraid_api_proto::core_v1::UpgradeSide;

    /// Two compatible ends over one duplex pair. Both sides learn the other's
    /// `Hello`, which is what the diagnostics screen renders.
    #[tokio::test]
    async fn two_ends_in_the_window_exchange_hellos() {
        let (client, server) = tokio::io::duplex(64 * 1024);
        let (mut client_recv, mut client_send) = tokio::io::split(client);
        let (mut server_recv, mut server_send) = tokio::io::split(server);

        let local = local_hello("1.0.0-alpha.0", &["replica"]);
        let remote = local_hello("1.0.0-alpha.0", &["replica", "media"]);

        let accepting = {
            let remote = remote.clone();
            tokio::spawn(async move {
                accept(&mut server_send, &mut server_recv, &remote)
                    .await
                    .map(|hello| hello.capabilities)
            })
        };
        let peer = dial(&mut client_send, &mut client_recv, &local)
            .await
            .expect("the window admits both");
        assert_eq!(peer.capabilities, ["replica", "media"]);
        assert_eq!(
            accepting.await.expect("the task joins").expect("accepted"),
            ["replica"]
        );
    }

    /// The one ordering claim #1020 makes about the handshake: a peer outside
    /// the window receives `UpgradeRequired` BEFORE any other message. The test
    /// asserts it by reading the accepting side's first frame and finding
    /// exactly that, with nothing in front of it.
    #[tokio::test]
    async fn an_out_of_window_peer_gets_upgrade_required_first_and_only() {
        let (client, server) = tokio::io::duplex(64 * 1024);
        let (mut client_recv, mut client_send) = tokio::io::split(client);
        let (mut server_recv, mut server_send) = tokio::io::split(server);

        // An old seat: schema 1, floor 1, against a gateway whose floor is 3.
        let seat = Hello {
            schema_version: 1,
            min_supported: 1,
            product_version: "0.9.0".to_owned(),
            capabilities: Vec::new(),
        };
        let gateway = Hello {
            schema_version: 4,
            min_supported: 3,
            product_version: "4.0.0".to_owned(),
            capabilities: Vec::new(),
        };

        let accepting =
            tokio::spawn(async move { accept(&mut server_send, &mut server_recv, &gateway).await });
        let error = dial(&mut client_send, &mut client_recv, &seat)
            .await
            .expect_err("outside the window");
        match error {
            ProtocolError::VersionWindow(upgrade) => {
                assert_eq!(upgrade.side, UpgradeSide::Peer as i32);
                assert_eq!(upgrade.schema_version, 4);
                assert_eq!(upgrade.min_supported, 3);
                assert_eq!(upgrade.peer_schema_version, 1);
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            accepting.await.expect("the task joins"),
            Err(ProtocolError::VersionWindow(_))
        ));
    }

    /// Anything but a `Hello` first on the stream is refused. A stream whose
    /// first frame is a request would otherwise be served by a build that never
    /// learned whether it can speak to the sender.
    #[tokio::test]
    async fn a_first_frame_that_is_not_a_hello_is_refused() {
        let mut wire = Vec::new();
        crate::wire::write_envelope(&mut wire, &crate::wire::cancel(0))
            .await
            .expect("write");
        let error = expect_hello_request(&mut wire.as_slice())
            .await
            .expect_err("refused");
        assert!(
            matches!(error, ProtocolError::UnsupportedMessage { .. }),
            "{error:?}"
        );
    }

    /// The handshake rides request id 0 and nothing else does. A `Hello` at a
    /// non-zero id is refused, because an id that was minted is an id the
    /// registry is tracking and the handshake is not a tracked request.
    #[tokio::test]
    async fn a_hello_at_a_non_zero_request_id_is_refused() {
        let mut wire = Vec::new();
        crate::wire::write_envelope(
            &mut wire,
            &request_envelope(
                7,
                Request {
                    kind: Some(request::Kind::Hello(local_hello("1.0.0", &[]))),
                },
            ),
        )
        .await
        .expect("write");
        let error = expect_hello_request(&mut wire.as_slice())
            .await
            .expect_err("refused");
        assert!(matches!(error, ProtocolError::BadRequestId(7)), "{error:?}");
    }
}
