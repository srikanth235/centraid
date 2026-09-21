//! One signed call, and the two things it is allowed to do about an answer
//! (#1029 §3, W5B-1).
//!
//! # THE RETRY RULE, WRITTEN ONCE
//!
//! **A request is attempted at most twice, and the second attempt exists for
//! exactly one refusal.** `Refusal::is_retryable_once` names it: a clock skew,
//! after the client has applied the server's own time. Everything else is
//! answered on the first attempt.
//!
//! A phone with a wrong clock is the ordinary case — one that has been off for
//! a month comes back with one — and a client that looped would hammer a server
//! whose clock is the broken one, on a device whose battery the member is
//! watching. So the second skew refusal is [`ClientError::ClockUnrecoverable`]
//! and the call ends.
//!
//! # THE SERVER-TOO-OLD LATCH
//!
//! `version::Skew::ServerTooOld` is not an error to show and retry past. The
//! phone **writes nothing** to that server — no upload, no commit, no lease
//! claim — because a write whose acknowledgement it does not understand is a
//! write it cannot reason about later (`gateway_core::version`). That is a
//! *latch* on [`GatewayClient`] rather than a check at each call site: a rule
//! every caller has to remember is a rule one caller forgets, and the forgotten
//! one is the background pass nobody watches.
//!
//! # WHAT THIS CLIENT NEVER SAYS
//!
//! That something is backed up. It returns what the gateway acknowledged and
//! nothing more; "backed up" is a word the shell may use **only** over a
//! [`CommitAck`] it holds. There is no optimistic path here and no method that
//! answers before the server has.

use centraid_gateway_core::checksum::AttestedChecksum;
use centraid_gateway_core::ids::{ObjectName, VaultId};
use centraid_gateway_core::version::{Range, Skew, negotiate};
use serde::Deserialize;

use crate::outcome::{ClientError, ErrorBody, ServerNeeds};
use crate::signer::DeviceSigner;
use crate::transport::{HttpRequest, HttpResponse, Transport};

/// The header a client attests a stored object's checksum in.
///
/// Its VALUE is the checksum the declaration bound to this name; its PRESENCE
/// is what the gateway records, because `ChecksumEvidence::None` is a rejection
/// at commit and not a shrug. The digest inside is the one `AttestedChecksum`
/// already computes rather than anything this crate chooses. (The amendment of
/// 2026-09-21 rules that the attested checksum goes entirely and the gateway
/// hashes what it stores; that is W17's, because it changes the wire.)
pub const ATTESTED_CHECKSUM_HEADER: &str = "centraid-attested-checksum";

/// What `/v1/health` said, and what this phone agreed to speak.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Preflight {
    /// The range the server advertises.
    pub server: (u32, u32),
    /// The highest version both understand.
    pub agreed: u32,
    /// The server's clock at the moment it answered.
    pub server_time_ms: i64,
}

#[derive(Debug, Deserialize)]
struct HealthBody {
    protocol_min: u32,
    protocol_max: u32,
    server_time_ms: i64,
}

/// What the gateway acknowledged for a commit. **The only thing a shell may
/// call "backed up".**
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CommitAck {
    /// The manifest head the gateway now holds, hex.
    pub head: String,
    /// When it committed, on the server's clock. This is the "last backed up"
    /// a member reads, and it is the server's moment and not the phone's.
    pub committed_at_ms: i64,
    /// Objects the gateway already had. Write-once means a re-declared name is
    /// an acknowledgement, not an error.
    #[serde(default)]
    pub already_committed: Vec<String>,
}

/// What a lease claim answered.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct LeaseAck {
    /// The epoch this device now holds.
    pub epoch: u64,
    /// The manifest head the gateway holds, if any.
    pub head: Option<String>,
}

/// One upload target the gateway handed back.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct UploadTarget {
    /// The object's name, hex.
    pub name: String,
    /// Where to PUT it. May be this gateway's own proxy path or a presigned URL
    /// at a bucket.
    pub url: String,
    /// When the target stops being usable, on the server's clock.
    ///
    /// **A background uploader must compare this against the longest deferral
    /// it can suffer**, not against now: iOS may hold a discretionary upload
    /// for days, and a target that expired while the phone was in a pocket is a
    /// silent failure. See [`crate::spool`].
    pub expires_at_ms: i64,
    /// The gateway already holds these bytes. Nothing to upload.
    pub already_committed: bool,
}

/// The phone's client for one vault on one gateway.
///
/// One per vault, because the signer is one per vault: a certificate names the
/// vault that issued it, and the server refuses a request whose path names a
/// different one.
#[derive(Debug)]
pub struct GatewayClient<T> {
    transport: T,
    signer: DeviceSigner,
    vault: VaultId,
    /// Latched once a server proves too old. See the module header.
    server_needs: Option<ServerNeeds>,
}

impl<T: Transport> GatewayClient<T> {
    /// A client over a transport, signing for one vault.
    #[must_use]
    pub const fn new(transport: T, signer: DeviceSigner, vault: VaultId) -> Self {
        Self {
            transport,
            signer,
            vault,
            server_needs: None,
        }
    }

    /// The vault this client speaks for.
    #[must_use]
    pub const fn vault(&self) -> &VaultId {
        &self.vault
    }

    /// The typed "this server needs an update" state, once it has been proved.
    #[must_use]
    pub const fn server_needs(&self) -> Option<ServerNeeds> {
        self.server_needs
    }

    /// The clock offset this client learned, in milliseconds.
    #[must_use]
    pub const fn clock_offset_ms(&self) -> i64 {
        self.signer.offset_ms()
    }

    /// Ask the server what it speaks, and agree a version.
    ///
    /// **Unsigned**, because `/v1/health` is: a phone that had to authenticate
    /// to find out the server is too old to authenticate against would have no
    /// way to learn it.
    ///
    /// # Errors
    ///
    /// [`ClientError::Version`] when the ranges do not overlap — and the
    /// `ServerTooOld` arm latches, so every later write refuses locally.
    pub async fn preflight(&mut self, phone_now_ms: i64) -> Result<Preflight, ClientError> {
        let response = self
            .transport
            .send(HttpRequest {
                method: "GET".to_owned(),
                path: "/v1/health".to_owned(),
                headers: [("accept".to_owned(), "application/json".to_owned())]
                    .into_iter()
                    .collect(),
                body: Vec::new(),
            })
            .await?;
        let health: HealthBody = decode(&response)?;
        let server = (health.protocol_min, health.protocol_max);

        // THE PHONE'S CLOCK IS CORRECTED HERE TOO, not only by a 401. A phone
        // that has been off for a month would otherwise spend its first signed
        // request earning a refusal it already had the answer to.
        self.signer.learn_clock(health.server_time_ms, phone_now_ms);

        match negotiate(
            Range::new(server.0, server.1),
            Range::new(crate::CLIENT_PROTOCOL_MIN, crate::CLIENT_PROTOCOL_MAX),
        ) {
            Skew::Agreed(agreed) => {
                self.signer.speak(agreed);
                Ok(Preflight {
                    server,
                    agreed,
                    server_time_ms: health.server_time_ms,
                })
            }
            Skew::ServerTooOld => {
                let needs = ServerNeeds::Update { server };
                self.server_needs = Some(needs);
                Err(ClientError::Version(needs))
            }
            Skew::ClientTooOld => Err(ClientError::Version(ServerNeeds::PhoneUpdate { server })),
        }
    }

    /// Claim the lease for this vault at this device's certified epoch.
    ///
    /// # Errors
    ///
    /// [`ClientError::Moved`] when a higher epoch holds it — the freeze (F1).
    pub async fn claim_lease(&mut self, phone_now_ms: i64) -> Result<LeaseAck, ClientError> {
        let path = format!("/v1/vaults/{}/lease", self.vault.hex());
        let response = self.write("POST", &path, Vec::new(), phone_now_ms).await?;
        decode(&response)
    }

    /// Declare the objects one generation produced, and get their targets.
    ///
    /// This is where the lease, the plan and the quota are judged, which is why
    /// it is one call for the whole batch: a phone that declared one object per
    /// request would learn its quota was spent partway through an upload it had
    /// already begun paying for.
    ///
    /// # Errors
    ///
    /// Any refusal, typed.
    pub async fn declare(
        &mut self,
        declarations: &serde_json::Value,
        phone_now_ms: i64,
    ) -> Result<Vec<UploadTarget>, ClientError> {
        let path = format!("/v1/vaults/{}/declare", self.vault.hex());
        let body = serde_json::to_vec(declarations).map_err(|error| ClientError::Malformed {
            reason: error.to_string(),
        })?;
        let response = self.write("POST", &path, body, phone_now_ms).await?;
        decode(&response)
    }

    /// Commit a declared set against the head this phone last saw.
    ///
    /// **The acknowledgement is the only backup claim there is.** A caller that
    /// showed "backed up" before this returned would be claiming something the
    /// gateway has not said.
    ///
    /// # Errors
    ///
    /// [`ClientError::Refused`] with `GatewayHeadConflict` when the
    /// compare-and-set lost: the loser re-reads, it does not clobber (F7).
    pub async fn commit(
        &mut self,
        request: &serde_json::Value,
        phone_now_ms: i64,
    ) -> Result<CommitAck, ClientError> {
        let path = format!("/v1/vaults/{}/commit", self.vault.hex());
        let body = serde_json::to_vec(request).map_err(|error| ClientError::Malformed {
            reason: error.to_string(),
        })?;
        let response = self.write("POST", &path, body, phone_now_ms).await?;
        decode(&response)
    }

    /// PUT one object's sealed bytes through the gateway's proxy.
    ///
    /// The foreground path. A background upload does not come through here: it
    /// takes [`Self::authorize_object_put`] and hands the platform a file.
    ///
    /// **THE ATTESTATION IS NOT OPTIONAL.** A store that was neither read nor
    /// attested says `ChecksumEvidence::None` at commit, and that is a
    /// rejection rather than a shrug — a client that omitted this header would
    /// upload every object successfully and then be refused at commit with
    /// `GatewayChecksumMissing`, which reads as a server fault and is not one.
    /// It is a parameter rather than something computed here because the
    /// checksum is the one the *declaration* bound to this name: recomputing it
    /// would be a second answer to what these bytes are.
    ///
    /// # Errors
    ///
    /// Any refusal, typed.
    pub async fn put_object(
        &mut self,
        name: &ObjectName,
        sealed: Vec<u8>,
        checksum: &AttestedChecksum,
        phone_now_ms: i64,
    ) -> Result<(), ClientError> {
        let path = format!("/v1/objects/{}/{}", self.vault.hex(), name.hex());
        self.write_attested("PUT", &path, sealed, Some(checksum), phone_now_ms)
            .await?;
        Ok(())
    }

    /// GET one object's sealed bytes back. The restore path.
    ///
    /// # Errors
    ///
    /// [`ClientError::Refused`] with `GatewayObjectUnknown` when the gateway
    /// does not hold it.
    pub async fn get_object(
        &mut self,
        name: &ObjectName,
        phone_now_ms: i64,
    ) -> Result<Vec<u8>, ClientError> {
        let path = format!("/v1/objects/{}/{}", self.vault.hex(), name.hex());
        // A GET is not a write, so it is allowed even against a server this
        // phone will not write to: RESTORE MUST WORK from a server the phone
        // has judged too old to trust with new bytes.
        let response = self.attempt("GET", &path, Vec::new(), phone_now_ms).await?;
        Ok(response.body)
    }

    /// **Sign a background object upload without reading the object.**
    ///
    /// What a `BGProcessingTask` or a `CoroutineWorker` carries: a path and four
    /// header values. The bytes stay in the sealed spool file and the OS streams
    /// them. See [`crate::signer::DeviceSigner::sign_object_put`] for why the
    /// digest is already known.
    ///
    /// It takes `&self`: authorising an upload changes nothing, which is what
    /// makes it callable from whatever thread the platform hands the app.
    ///
    /// The attestation header rides with it for [`Self::put_object`]'s reason,
    /// and it matters more here: a background task that uploaded a whole
    /// generation unattested would be refused at the *next* commit, hours
    /// later, with nothing on screen to connect the two.
    #[must_use]
    pub fn authorize_object_put(
        &self,
        name: &ObjectName,
        checksum: &AttestedChecksum,
        phone_now_ms: i64,
    ) -> (String, Vec<(String, String)>) {
        let (path, headers) = self
            .signer
            .sign_object_put(&self.vault.hex(), name, phone_now_ms);
        let mut carried: Vec<(String, String)> = headers
            .pairs()
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value))
            .collect();
        carried.push((ATTESTED_CHECKSUM_HEADER.to_owned(), checksum.hex()));
        (path, carried)
    }

    /// A write, refused locally when the server is known to be too old.
    async fn write(
        &mut self,
        method: &str,
        path: &str,
        body: Vec<u8>,
        phone_now_ms: i64,
    ) -> Result<HttpResponse, ClientError> {
        self.write_attested(method, path, body, None, phone_now_ms)
            .await
    }

    async fn write_attested(
        &mut self,
        method: &str,
        path: &str,
        body: Vec<u8>,
        checksum: Option<&AttestedChecksum>,
        phone_now_ms: i64,
    ) -> Result<HttpResponse, ClientError> {
        if let Some(needs @ ServerNeeds::Update { .. }) = self.server_needs {
            // IT WRITES NOTHING TO THAT SERVER. Not a request that will be
            // refused — no request at all, so there is nothing for an operator
            // to see in a log and nothing for a member's battery to pay for.
            return Err(ClientError::Version(needs));
        }
        self.attempt_attested(method, path, body, checksum, phone_now_ms)
            .await
    }

    async fn attempt(
        &mut self,
        method: &str,
        path: &str,
        body: Vec<u8>,
        phone_now_ms: i64,
    ) -> Result<HttpResponse, ClientError> {
        self.attempt_attested(method, path, body, None, phone_now_ms)
            .await
    }

    /// Sign, send, and spend the one retry the rules allow.
    async fn attempt_attested(
        &mut self,
        method: &str,
        path: &str,
        body: Vec<u8>,
        checksum: Option<&AttestedChecksum>,
        phone_now_ms: i64,
    ) -> Result<HttpResponse, ClientError> {
        let first = self
            .send_signed(method, path, body.clone(), checksum, phone_now_ms)
            .await?;
        if first.status < 400 {
            return Ok(first);
        }
        let refusal: ErrorBody = decode(&first)?;
        let typed = ClientError::from_body(first.status, &refusal);
        let ClientError::Refused {
            code: centraid_api_proto::core_v1::ErrorCode::GatewayClockSkew,
            ..
        } = typed
        else {
            if let ClientError::Version(needs @ ServerNeeds::Update { .. }) = typed {
                self.server_needs = Some(needs);
            }
            return Err(typed);
        };

        // THE ONE RETRY. Apply the server's own clock and sign again.
        self.signer
            .learn_clock(refusal.server_time_ms, phone_now_ms);
        let second = self
            .send_signed(method, path, body, checksum, phone_now_ms)
            .await?;
        if second.status < 400 {
            return Ok(second);
        }
        let again: ErrorBody = decode(&second)?;
        match ClientError::from_body(second.status, &again) {
            ClientError::Refused {
                code: centraid_api_proto::core_v1::ErrorCode::GatewayClockSkew,
                ..
            } => Err(ClientError::ClockUnrecoverable {
                server_time_ms: again.server_time_ms,
            }),
            other => Err(other),
        }
    }

    async fn send_signed(
        &self,
        method: &str,
        path: &str,
        body: Vec<u8>,
        checksum: Option<&AttestedChecksum>,
        phone_now_ms: i64,
    ) -> Result<HttpResponse, ClientError> {
        let headers = self.signer.sign(method, path, &body, phone_now_ms);
        let mut map: std::collections::BTreeMap<String, String> = headers
            .pairs()
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value))
            .collect();
        if let Some(checksum) = checksum {
            // OUTSIDE THE SIGNATURE, deliberately. The signature already covers
            // the body's own digest, so a middlebox that rewrote this header
            // could make a commit FAIL and never make one succeed over bytes
            // nobody declared. Putting it in the preimage would mean changing
            // `gateway_core::auth`, which both server adapters verify with —
            // a protocol change to carry a fact the protocol already binds.
            map.insert(ATTESTED_CHECKSUM_HEADER.to_owned(), checksum.hex());
            map.insert(
                "content-type".to_owned(),
                "application/octet-stream".to_owned(),
            );
        } else if !body.is_empty() {
            map.insert("content-type".to_owned(), "application/json".to_owned());
        }
        Ok(self
            .transport
            .send(HttpRequest {
                method: method.to_owned(),
                path: path.to_owned(),
                headers: map,
                body,
            })
            .await?)
    }
}

fn decode<D: serde::de::DeserializeOwned>(response: &HttpResponse) -> Result<D, ClientError> {
    serde_json::from_slice(&response.body).map_err(|error| ClientError::Malformed {
        reason: format!("status {}: {error}", response.status),
    })
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use centraid_api_proto::core_v1::ErrorCode;
    use centraid_gateway_core::ids::Key32;
    use centraid_identity::{DeviceCertificate, DeviceKey, Epoch, RecoveryPhrase, VaultMint};

    use super::*;
    use crate::outcome::spelling_of;
    use crate::transport::TransportError;

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                          abandon abandon abandon abandon abandon abandon abandon abandon \
                          abandon abandon abandon abandon abandon abandon abandon art";

    /// A transport that answers from a script and records what it was asked.
    ///
    /// It is a script and not a stub gateway on purpose: what these tests are
    /// about is the CLIENT'S behaviour on an answer — how many times it sends,
    /// what it signs the second time, what it refuses to send at all. The
    /// answers themselves are checked against the real server in
    /// `tests/over_the_wire.rs`.
    struct Scripted {
        answers: RefCell<Vec<HttpResponse>>,
        seen: RefCell<Vec<HttpRequest>>,
    }

    impl Scripted {
        fn new(answers: Vec<HttpResponse>) -> Self {
            Self {
                answers: RefCell::new(answers),
                seen: RefCell::new(Vec::new()),
            }
        }
    }

    impl Transport for &Scripted {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
            self.seen.borrow_mut().push(request);
            let mut answers = self.answers.borrow_mut();
            if answers.is_empty() {
                return Err(TransportError::new("the script ran out"));
            }
            Ok(answers.remove(0))
        }
    }

    fn json(status: u16, body: &str) -> HttpResponse {
        HttpResponse {
            status,
            body: body.as_bytes().to_vec(),
        }
    }

    fn skew(server_time_ms: i64) -> HttpResponse {
        json(
            401,
            &format!(
                r#"{{"code":"{}","server_time_ms":{server_time_ms}}}"#,
                format_args!("{:?}", ErrorCode::GatewayClockSkew)
            ),
        )
    }

    fn client(transport: &Scripted) -> GatewayClient<&Scripted> {
        let seed = RecoveryPhrase::parse(PHRASE).expect("parses").seed();
        let keys = VaultMint::fresh().mint(&seed, 0).expect("derives");
        let device = DeviceKey::generate().expect("a device key");
        let certificate = DeviceCertificate::issue(&keys.identity, &device.public(), Epoch::new(1));
        let vault = Key32::from_bytes(keys.identity.public().to_bytes());
        GatewayClient::new(transport, DeviceSigner::new(device, &certificate, 1), vault)
    }

    /// A PHONE WITH A WRONG CLOCK RE-SIGNS ONCE AND GETS THROUGH.
    #[tokio::test]
    async fn a_skewed_clock_is_corrected_and_the_call_succeeds() {
        let script = Scripted::new(vec![
            skew(1_770_000_000_000),
            json(200, r#"{"epoch":2,"head":null}"#),
        ]);
        let mut client = client(&script);
        let ack = client
            .claim_lease(1_000_000_000_000)
            .await
            .expect("the second attempt is accepted");
        assert_eq!(ack.epoch, 2);
        assert_eq!(script.seen.borrow().len(), 2, "exactly two attempts");
        assert_eq!(
            client.clock_offset_ms(),
            770_000_000_000,
            "the offset is the server's time minus the phone's"
        );
        // The second request carried the corrected timestamp, not the phone's.
        let second = &script.seen.borrow()[1];
        assert_eq!(
            second.headers.get("centraid-timestamp"),
            Some(&"1770000000000".to_owned())
        );
    }

    /// **A PHONE WITH A WRONG CLOCK MUST NOT LOOP.** A second skew refusal is a
    /// real failure, and a client that kept correcting would hammer a server
    /// whose clock is the broken one.
    #[tokio::test]
    async fn a_clock_that_is_still_wrong_after_one_correction_stops() {
        let script = Scripted::new(vec![skew(1_770_000_000_000), skew(1_780_000_000_000)]);
        let mut client = client(&script);
        let failure = client
            .claim_lease(1_000_000_000_000)
            .await
            .expect_err("it gives up");
        assert_eq!(
            failure,
            ClientError::ClockUnrecoverable {
                server_time_ms: 1_780_000_000_000
            }
        );
        assert_eq!(script.seen.borrow().len(), 2, "two attempts, never three");
    }

    /// THE SERVER-TOO-OLD LATCH, AND WHAT IT COSTS A SERVER: nothing. After the
    /// preflight refuses, no further request is sent at all.
    #[tokio::test]
    async fn a_server_below_this_phones_minimum_is_written_to_zero_times() {
        let script = Scripted::new(vec![json(
            200,
            r#"{"protocol_min":0,"protocol_max":0,"server_time_ms":5}"#,
        )]);
        let mut client = client(&script);
        // `CLIENT_PROTOCOL_MIN` is 1 while "v0, no legacy" holds, so a server
        // advertising 0..0 is one this phone cannot speak to.
        let refusal = client.preflight(5).await.expect_err("no overlap");
        assert_eq!(
            refusal,
            ClientError::Version(ServerNeeds::Update { server: (0, 0) })
        );
        assert_eq!(
            client.server_needs(),
            Some(ServerNeeds::Update { server: (0, 0) })
        );

        let after = client.claim_lease(5).await.expect_err("latched");
        assert_eq!(
            after,
            ClientError::Version(ServerNeeds::Update { server: (0, 0) })
        );
        assert_eq!(
            script.seen.borrow().len(),
            1,
            "the health check, and nothing after it"
        );
    }

    /// RESTORE MUST WORK from a server this phone will not write to. A member
    /// whose self-hosted box is a year behind still gets their vault back.
    #[tokio::test]
    async fn a_latched_client_still_reads() {
        let script = Scripted::new(vec![
            json(
                200,
                r#"{"protocol_min":0,"protocol_max":0,"server_time_ms":5}"#,
            ),
            HttpResponse {
                status: 200,
                body: b"sealed bytes".to_vec(),
            },
        ]);
        let mut client = client(&script);
        let _ = client.preflight(5).await;
        let name = ObjectName::of(b"sealed bytes");
        let bytes = client.get_object(&name, 5).await.expect("a read");
        assert_eq!(bytes, b"sealed bytes");
    }

    /// THE VAULT MOVED, with its companion, straight through to the freeze.
    #[tokio::test]
    async fn a_moved_vault_surfaces_the_epoch_and_the_moment() {
        let script = Scripted::new(vec![json(
            409,
            &format!(
                r#"{{"code":"{}","server_time_ms":9,"moved":{{"current_epoch":2,"moved_at_ms":7}}}}"#,
                spelling_of(&centraid_gateway_core::error::Refusal::VaultMoved {
                    current_epoch: 2,
                    moved_at: centraid_gateway_core::time::ServerTime::from_millis(7),
                })
            ),
        )]);
        let mut client = client(&script);
        assert_eq!(
            client.claim_lease(9).await.expect_err("moved"),
            ClientError::Moved {
                current_epoch: 2,
                moved_at_ms: 7,
            }
        );
        assert_eq!(script.seen.borrow().len(), 1, "a move is not retried");
    }

    /// A lost compare-and-set is NOT retried unchanged: the loser re-reads
    /// (F7). One attempt, and the code reaches the caller.
    #[tokio::test]
    async fn a_head_conflict_is_answered_once_and_handed_back() {
        let script = Scripted::new(vec![json(
            409,
            &format!(
                r#"{{"code":"{:?}","server_time_ms":9}}"#,
                ErrorCode::GatewayHeadConflict
            ),
        )]);
        let mut client = client(&script);
        let failure = client
            .commit(&serde_json::json!({}), 9)
            .await
            .expect_err("conflict");
        assert!(matches!(
            failure,
            ClientError::Refused {
                code: ErrorCode::GatewayHeadConflict,
                ..
            }
        ));
        assert_eq!(script.seen.borrow().len(), 1);
    }

    /// A transport failure is not a refusal, and nothing about the member's
    /// plan is claimed on the strength of a tunnel.
    #[tokio::test]
    async fn an_unreachable_gateway_is_a_transport_failure_and_not_a_refusal() {
        let script = Scripted::new(Vec::new());
        let mut client = client(&script);
        assert!(matches!(
            client.claim_lease(1).await.expect_err("nothing answered"),
            ClientError::Transport(_)
        ));
    }

    /// EVERY SIGNED REQUEST CARRIES ALL FOUR HEADERS. A missing one is a
    /// refusal a member cannot act on.
    #[tokio::test]
    async fn every_request_carries_the_four_signed_headers() {
        let script = Scripted::new(vec![json(200, r#"{"epoch":1,"head":null}"#)]);
        let mut client = client(&script);
        let _ = client.claim_lease(1).await;
        let seen = script.seen.borrow();
        for name in [
            "centraid-certificate",
            "centraid-signature",
            "centraid-timestamp",
            "centraid-protocol",
        ] {
            assert!(seen[0].headers.contains_key(name), "{name} is missing");
        }
    }
}
