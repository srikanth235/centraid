#![forbid(unsafe_code)]
//! THE HOSTED GATEWAY, AS A CLOUDFLARE WORKER (#1029 §3).
//!
//! One protocol, two deployments. This is the paid hosted one;
//! `crates/gateway-server` is the standalone one anyone can run; and **neither
//! is the reference implementation — the protocol and its conformance suite
//! are.** A phone cannot tell which of the two it is talking to, and this crate
//! is one of the two places that promise is either kept or quietly broken.
//!
//! # THERE ARE NO RULES IN THIS CRATE
//!
//! Every refusal, every floor, every checksum comparison, every quota and every
//! scope check is `centraid-gateway-core`'s. What is here is a router, three
//! Durable Objects, a bucket and a certificate — the four things a rule cannot
//! be, which is exactly why the ports exist. `tests/no_rules_here.rs` is the
//! grep that says so, and it is the same shape the standalone adapter carries.
//!
//! If a change here would make one of this Worker's answers differ from the
//! standalone server's, **the change belongs in `gateway-core`**.
//!
//! # THE SHAPE
//!
//! | Piece | What it is |
//! | --- | --- |
//! | [`VaultObject`] | **one Durable Object per vault.** Its single-request execution is the lease fence and the manifest compare-and-set's atomicity (F7) |
//! | [`MailboxObject`] | one per mailbox, addressed by the recipient's identity key, with an alarm for the TTL |
//! | [`AccountObject`] | one per account: the vault listing a restored phone reads, and the purchase map |
//! | [`r2`] | the bytes. Presigned S3 URLs out, the binding for the gateway's own reads |
//! | [`vault`] | `StateStore` over the Durable Object's SQLite, running `contracts/gateway/`'s statements unchanged |
//! | [`accounts`] | admission by key and purchase — the one place the deployments differ, ending in the same state |
//! | [`wire`] | headers, statuses and the error body, companions and all |
//! | [`conformance`] | the shared suite, driven inside a real Durable Object |
//!
//! # WHY A DURABLE OBJECT AND NOT A DATABASE
//!
//! A Durable Object **runs one request at a time**. One object per vault means
//! every request for that vault is serialised by the runtime, which is what
//! makes the lease fence and `compare_and_set_head` correct with no transaction
//! and no lock — the property the standalone adapter buys with `BEGIN
//! IMMEDIATE`. It is also what makes the per-capability mailbox rate limit a
//! plain `COUNT(*)` instead of a distributed counter.
//!
//! Its SQLite caps at **10 GB**, which is why the per-object index lives there
//! and per-item rows do not: an object row is under 200 bytes, so ten million
//! objects is about 2 GB, and a vault with ten million objects holds 160 TB at
//! the 16 MiB cap. The item ledger is on the phone, where it is readable.
//!
//! # NO PUSH IN v0
//!
//! Workers cannot accept QUIC and cannot hold a long-lived stream cheaply, and
//! nothing here needs to wake a phone: uploads are phone-initiated, restore is
//! member-initiated, and no other client exists to wait on one. Mailboxes are
//! drained when the app comes to the foreground.

pub mod accounts;
#[cfg(target_arch = "wasm32")]
pub mod conformance;
#[cfg(target_arch = "wasm32")]
pub mod mailbox;
#[cfg(target_arch = "wasm32")]
pub mod r2;
pub mod sigv4;
pub mod sql;
#[cfg(target_arch = "wasm32")]
pub mod vault;
pub mod wire;

// EVERYTHING BELOW THIS LINE TOUCHES THE PLATFORM.
//
// A Durable Object, a bucket, a `Request` or a `Response`: none of them build
// for a host target, because `worker` is `wasm-bindgen` all the way down. The
// pure halves above — the SigV4 presigner, the receipt interpretation, the
// shared statements and the error body's shape — do, and their tests therefore
// RUN under `cargo test` instead of being written and never executed. That is
// the whole reason for this cfg: a test that cannot run is not a test.
#[cfg(target_arch = "wasm32")]
mod platform {
    use super::*;

    use centraid_gateway_core::engine::{Caller, CommitInput, Fault, Gateway};
    use centraid_gateway_core::error::Refusal;
    use centraid_gateway_core::ids::{Generation, Key32, ObjectKind, ObjectName, VaultId};
    use centraid_gateway_core::retention::Policy;
    use centraid_gateway_core::store::{StateStore as _, StoreFault};
    use centraid_gateway_core::time::ServerTime;
    use centraid_gateway_core::upload::Declaration;
    use centraid_gateway_core::{PROTOCOL_MAX, PROTOCOL_MIN, auth, version};
    use centraid_identity::DeviceCertificate;
    use serde::{Deserialize, Serialize};
    use wasm_bindgen::JsCast as _;
    use worker::{
        Context, DurableObject, Env, Headers, Method, Request, Response, Result as WorkerResult,
        State, durable_object, event,
    };

    use crate::accounts::{AccountStore, PlanConfig};
    use crate::conformance::WorkerHarness;
    use crate::mailbox::MailboxStore;
    use crate::r2::{R2Bytes, S3Face, object_key};
    use crate::vault::DurableState;
    use crate::wire::{
        CERTIFICATE_HEADER, PROTOCOL_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, refused,
    };

    /// The R2 bucket binding's name.
    const BUCKET: &str = "OBJECTS";
    /// The per-vault Durable Object namespace.
    const VAULTS: &str = "VAULTS";
    /// The per-mailbox Durable Object namespace.
    const MAILBOXES: &str = "MAILBOXES";
    /// The per-account Durable Object namespace.
    const ACCOUNTS: &str = "ACCOUNTS";

    /// The gateway's own clock, in milliseconds.
    ///
    /// **A Worker has no ambient clock a rule may reach for** — `SystemTime::now()`
    /// compiles to `wasm32-unknown-unknown` and then panics — so time enters this
    /// crate here and is passed *down* into every rule, exactly as `gateway-core`'s
    /// module docs require.
    fn now() -> ServerTime {
        ServerTime::from_millis(worker::Date::now().as_millis() as i64)
    }

    /// Parse the S3 face out of the environment, or `None` if it was not
    /// configured.
    ///
    /// **Not an error**: a Worker with no S3 credentials still serves every commit
    /// and every delete — it just cannot presign, and `presign_put` refuses with a
    /// message naming the secret. An operator who has not finished setting up gets
    /// a clear failure on one route rather than a Worker that will not boot.
    fn s3_face(env: &Env) -> Option<S3Face> {
        let host = env.var("R2_S3_HOST").ok()?.to_string();
        let bucket = env.var("R2_BUCKET").ok()?.to_string();
        let access_key_id = env.secret("R2_ACCESS_KEY_ID").ok()?.to_string();
        let secret_access_key = env.secret("R2_SECRET_ACCESS_KEY").ok()?.to_string();
        if host.is_empty() || bucket.is_empty() || access_key_id.is_empty() {
            return None;
        }
        Some(S3Face {
            host,
            bucket,
            credentials: sigv4::Credentials {
                access_key_id,
                secret_access_key,
                // R2's own region token. Every R2 bucket is `auto`; it is read from
                // the environment anyway so that an S3-compatible store that is not
                // R2 can be pointed at without a code change.
                region: env
                    .var("R2_REGION")
                    .map_or_else(|_| "auto".to_owned(), |value| value.to_string()),
            },
        })
    }

    fn plan_config(env: &Env) -> PlanConfig {
        PlanConfig {
            product_quotas: env.var("PRODUCT_QUOTAS").map_or_else(
                |_| Vec::new(),
                |raw| accounts::product_quotas(&raw.to_string()),
            ),
            // ZERO IS THE DEFAULT, and it is the safe answer rather than the
            // generous one: keys are free to mint, so an unbounded free tier is
            // unbounded Sybil storage (F13). An operator who wants one sets it.
            free_quota_bytes: env
                .var("FREE_QUOTA_BYTES")
                .ok()
                .and_then(|raw| raw.to_string().parse().ok())
                .unwrap_or(0),
        }
    }

    /// The retention policy.
    ///
    /// **There is no narrowing knob and there is not going to be one.** The floor
    /// is a promise to a member (F10), and an operator who could shorten it could
    /// delete somebody's only backup by editing an environment variable.
    fn policy() -> Policy {
        Policy::default()
    }

    // ------------------------------------------------------------- the Worker --

    /// Route by the first path segment and hand the whole request to the object
    /// that owns it.
    ///
    /// **The Worker itself decides nothing.** It does not check a signature, read a
    /// quota or touch a bucket: it looks at a path, picks a Durable Object and
    /// forwards. Authentication happens inside the object, beside the state it is
    /// about, so that there is one place a request is judged rather than two that
    /// can disagree.
    ///
    /// # Errors
    ///
    /// A worker error if a response cannot be built.
    #[event(fetch)]
    pub async fn fetch(request: Request, env: Env, _context: Context) -> WorkerResult<Response> {
        let url = request.url()?;
        let path: Vec<String> = url
            .path_segments()
            .map(|segments| segments.map(str::to_owned).collect())
            .unwrap_or_default();

        let response = match path.first().map(String::as_str) {
            // `/v/{vault}/…` — everything about one vault.
            Some("v") => match path.get(1).and_then(|hex| key_of(hex)) {
                Some(vault) => forward(&env, VAULTS, &vault.hex(), request).await,
                None => refused(&Refusal::UnknownVault, now().millis()),
            },
            // `/m/{identity key}/…` — one mailbox.
            Some("m") => match path.get(1).and_then(|hex| key_of(hex)) {
                Some(mailbox) => forward(&env, MAILBOXES, &mailbox.hex(), request).await,
                None => refused(&Refusal::UnknownVault, now().millis()),
            },
            // `/a/{account}/…` — one account.
            Some("a") => match path.get(1).and_then(|hex| key_of(hex)) {
                Some(account) => forward(&env, ACCOUNTS, &account.hex(), request).await,
                None => refused(&Refusal::UnknownVault, now().millis()),
            },
            // THE PROTOCOL RANGE, ON A ROUTE THAT NEEDS NO SIGNATURE. A phone
            // deciding whether it can talk to this server at all should not have to
            // sign something first.
            Some("version") => Response::from_json(&VersionBody {
                protocol_min: PROTOCOL_MIN,
                protocol_max: PROTOCOL_MAX,
                server_time_ms: now().millis(),
            }),
            // The shared suite. 404 unless this deployment was started with the
            // flag, so a production Worker does not carry a route that resets a
            // vault's storage.
            Some("__conformance") if env.var("CONFORMANCE").is_ok() => {
                forward(&env, VAULTS, "__conformance", request).await
            }
            _ => Response::error("not found", 404),
        }?;
        wire::with_protocol_range(response, PROTOCOL_MIN, PROTOCOL_MAX)
    }

    /// The server's range, and its clock.
    #[derive(Debug, Serialize)]
    struct VersionBody {
        protocol_min: u32,
        protocol_max: u32,
        server_time_ms: i64,
    }

    async fn forward(
        env: &Env,
        namespace: &str,
        name: &str,
        request: Request,
    ) -> WorkerResult<Response> {
        env.durable_object(namespace)?
            .id_from_name(name)?
            .get_stub()?
            .fetch_with_request(request)
            .await
    }

    fn key_of(hex_text: &str) -> Option<Key32> {
        hex::decode(hex_text)
            .ok()
            .and_then(|bytes| Key32::from_slice(&bytes))
    }

    // ------------------------------------------------------------------ auth ----

    /// Authenticate a request against the vault its path names.
    ///
    /// Byte for byte the standalone adapter's check, because it reaches the same
    /// functions: `DeviceCertificate::from_bytes` and `verify` for the certificate,
    /// and `auth::verify_request` — over `auth::preimage` — for the signature. **A
    /// Worker that assembled its own preimage would be a Worker that rejects
    /// requests the phone signed correctly**, and the phone signs with that same
    /// function.
    ///
    /// # Errors
    ///
    /// A [`Refusal`]: skew carries the server's time, and everything else is
    /// `SignatureInvalid` or `UnknownVault`.
    fn authenticate(
        headers: &Headers,
        method: &str,
        path: &str,
        body: &[u8],
        vault: VaultId,
        at: ServerTime,
    ) -> Result<Caller, Refusal> {
        let get = |name: &str| headers.get(name).ok().flatten();

        let protocol: u32 = get(PROTOCOL_HEADER)
            .and_then(|text| text.parse().ok())
            .ok_or(Refusal::SignatureInvalid)?;
        version::admit(version::Range::new(PROTOCOL_MIN, PROTOCOL_MAX), protocol)?;

        let certificate_bytes = get(CERTIFICATE_HEADER)
            .and_then(|text| hex::decode(text).ok())
            .ok_or(Refusal::SignatureInvalid)?;
        let signature = get(SIGNATURE_HEADER)
            .and_then(|text| hex::decode(text).ok())
            .ok_or(Refusal::SignatureInvalid)?;
        let timestamp_ms: i64 = get(TIMESTAMP_HEADER)
            .and_then(|text| text.parse().ok())
            .ok_or(Refusal::SignatureInvalid)?;

        let certificate = DeviceCertificate::from_bytes(&certificate_bytes)
            .map_err(|_| Refusal::SignatureInvalid)?;
        certificate
            .verify()
            .map_err(|_| Refusal::SignatureInvalid)?;

        let identity = Key32::from_bytes(certificate.identity().to_bytes());
        // TENANT ISOLATION, AT ITS ONE CHOKE POINT. The certificate names a vault;
        // the path names a vault; a request where they differ is one account
        // reaching for another's, and it is refused as a stranger rather than as
        // anything more specific — a gateway that distinguished them would answer
        // "does this identity key have a vault here?" for anyone who asked.
        if identity != vault {
            return Err(Refusal::UnknownVault);
        }

        let device = Key32::from_bytes(certificate.device().to_bytes());
        let epoch = certificate.epoch().get();
        auth::verify_request(
            &auth::SignedRequest {
                method,
                path,
                body_digest: *blake3::hash(body).as_bytes(),
                timestamp_ms,
                protocol,
                certificate_bytes: &certificate_bytes,
                signature: &signature,
            },
            &auth::CertifiedDevice::already_verified(identity, device, epoch),
            at,
            auth::DEFAULT_REPLAY_WINDOW,
        )?;

        Ok(Caller {
            vault,
            device,
            epoch,
            now: at,
        })
    }

    // ------------------------------------------------------- the vault object --

    /// ONE DURABLE OBJECT PER VAULT. Its single-request execution is the lease
    /// fence and the manifest compare-and-set's atomicity (F7).
    #[durable_object]
    pub struct VaultObject {
        state: State,
        env: Env,
    }

    impl DurableObject for VaultObject {
        fn new(state: State, env: Env) -> Self {
            Self { state, env }
        }

        async fn fetch(&self, mut request: Request) -> WorkerResult<Response> {
            let at = now();
            let url = request.url()?;
            let path = url.path().to_owned();
            let segments: Vec<String> = url
                .path_segments()
                .map(|segments| segments.map(str::to_owned).collect())
                .unwrap_or_default();
            let method = request.method();
            let body = request.bytes().await.unwrap_or_default();
            let headers = request.headers().clone();

            // The suite, before anything is authenticated: it is not a phone and
            // there is no certificate to check. The route is unreachable unless the
            // Worker was started with the flag.
            if segments
                .first()
                .is_some_and(|first| first == "__conformance")
            {
                // `?forgetful=1` runs the same suite against a harness that drops
                // uploads on the floor, and it must go RED. Without that, every
                // green run above is satisfied by a harness that quietly did
                // nothing — and the check has to be made against THIS harness, not
                // only against the other two adapters'.
                let forgetful = url.query().is_some_and(|query| query.contains("forgetful"));
                return self.run_conformance(forgetful).await;
            }

            let Some(vault) = segments.get(1).and_then(|hex| key_of(hex)) else {
                return refused(&Refusal::UnknownVault, at.millis());
            };
            let caller = match authenticate(
                &headers,
                method.to_string().as_str(),
                &path,
                &body,
                vault,
                at,
            ) {
                Ok(caller) => caller,
                Err(refusal) => return refused(&refusal, at.millis()),
            };

            let mut gateway = match self.gateway() {
                Ok(gateway) => gateway,
                Err(fault) => return wire::internal(&fault.0, at.millis()),
            };

            let outcome = match (method, segments.get(2).map(String::as_str)) {
                (Method::Post, Some("lease")) => claim_lease(&mut gateway, caller).await,
                (Method::Post, Some("uploads")) => declare(&mut gateway, caller, &body).await,
                (Method::Post, Some("commit")) => commit(&mut gateway, caller, &body).await,
                (Method::Post, Some("delete")) => delete(&mut gateway, caller, &body).await,
                (Method::Get, Some("g")) => generations(&mut gateway, caller).await,
                (Method::Get, Some("o")) => {
                    let Some(name) = segments.get(3).and_then(|hex| key_of(hex)) else {
                        return refused(&Refusal::UnknownVault, at.millis());
                    };
                    self.read_object(&gateway, caller, name).await
                }
                _ => return Response::error("not found", 404),
            };

            match outcome {
                Ok(response) => response,
                Err(Fault::Refused(refusal)) => refused(&refusal, at.millis()),
                Err(Fault::Store(fault)) => wire::internal(&fault.0, at.millis()),
            }
        }
    }

    impl VaultObject {
        fn gateway(&self) -> Result<Gateway<DurableState, R2Bytes>, StoreFault> {
            let bucket = self
                .env
                .bucket(BUCKET)
                .map_err(|error| StoreFault::new(error.to_string()))?;
            Ok(Gateway::new(
                DurableState::open(self.state.storage().sql())?,
                R2Bytes::new(bucket, s3_face(&self.env)),
                policy(),
            ))
        }

        async fn run_conformance(&self, forgetful: bool) -> WorkerResult<Response> {
            let bucket = self.env.bucket(BUCKET)?;
            let harness = match WorkerHarness::new(
                self.state.storage().sql(),
                bucket,
                s3_face(&self.env),
                policy(),
            ) {
                Ok(harness) => harness,
                Err(fault) => return Response::error(fault.0, 500),
            };
            if forgetful {
                let mut harness = crate::conformance::ForgetfulHarness(harness);
                let report = centraid_gateway_core::conformance::run(&mut harness).await;
                let mut body = report.render();
                // INVERTED ON PURPOSE. A forgetful harness that reported GREEN is
                // the failure, so this route's verdict is "did it go red".
                body.push_str(if report.is_green() {
                    "FORGETFUL-GREEN\n"
                } else {
                    "GREEN\n"
                });
                return Response::ok(body);
            }
            let mut harness = harness;
            let report = centraid_gateway_core::conformance::run(&mut harness).await;
            // A LINE PER CASE AND THEN A VERDICT. The suite never panics — a Worker
            // has no test harness to catch one — so the verdict is what the runner
            // asserts on.
            let mut body = report.render();
            body.push_str(if report.is_green() {
                "GREEN\n"
            } else {
                "RED\n"
            });
            Response::ok(body)
        }

        /// A read. **Presigned rather than proxied**, because R2 charges no egress
        /// and a Worker in the path would be a Worker billed per byte for moving
        /// bytes it cannot read.
        async fn read_object(
            &self,
            gateway: &Gateway<DurableState, R2Bytes>,
            caller: Caller,
            name: ObjectName,
        ) -> Result<WorkerResult<Response>, Fault> {
            let state = gateway.vault(&caller.vault).await?;
            state.plan.authorize_read().map_err(Fault::Refused)?;
            // The object must be one this vault holds. Without this a presigned URL
            // would be issued for any name at all under this vault's prefix, which
            // is a read oracle over a bucket.
            gateway
                .state
                .object(&caller.vault, &name)
                .await?
                .ok_or(Fault::Refused(Refusal::ObjectUnknown(name)))?;
            let Some(s3) = s3_face(&self.env) else {
                return Err(Fault::Store(StoreFault::new(
                    "this Worker has no R2 S3 credentials, so it cannot presign a read",
                )));
            };
            let path = sigv4::encode_path(&format!(
                "/{}/{}",
                s3.bucket,
                object_key(&caller.vault, &name)
            ));
            let url = sigv4::presign(
                &sigv4::PresignRequest {
                    method: "GET",
                    host: &s3.host,
                    path: &path,
                    timestamp: &sigv4::timestamp(caller.now.millis()),
                    expires_in: sigv4::MAX_EXPIRY_SECONDS,
                },
                &s3.credentials,
            );
            Ok(Response::from_json(&ReadResponse { url }))
        }
    }

    async fn claim_lease(
        gateway: &mut Gateway<DurableState, R2Bytes>,
        caller: Caller,
    ) -> Result<WorkerResult<Response>, Fault> {
        let state = gateway.claim_lease(caller).await?;
        Ok(Response::from_json(&LeaseBody {
            epoch: state.lease.current.map_or(0, |lease| lease.epoch),
            head: state.head.map(|head| head.hex()),
        }))
    }

    async fn declare(
        gateway: &mut Gateway<DurableState, R2Bytes>,
        caller: Caller,
        body: &[u8],
    ) -> Result<WorkerResult<Response>, Fault> {
        let request: DeclareRequest = parse(body)?;
        let mut declarations = Vec::with_capacity(request.objects.len());
        for declared in &request.objects {
            declarations.push(declared.parse()?);
        }
        let targets = gateway.declare(caller, &declarations).await?;
        Ok(Response::from_json(&DeclareResponse {
            targets: targets
                .iter()
                .map(|target| TargetBody {
                    name: target.name.hex(),
                    url: target.url.clone(),
                    expires_at_ms: target.expires_at.millis(),
                    already_committed: target.already_committed,
                })
                .collect(),
        }))
    }

    async fn commit(
        gateway: &mut Gateway<DurableState, R2Bytes>,
        caller: Caller,
        body: &[u8],
    ) -> Result<WorkerResult<Response>, Fault> {
        let request: CommitRequest = parse(body)?;
        let outcome = gateway.commit(caller, &request.parse()?).await?;
        Ok(Response::from_json(&CommitResponse {
            head: outcome.head.hex(),
            committed_at_ms: outcome.committed_at.millis(),
            already_committed: outcome
                .already_committed
                .iter()
                .map(ObjectName::hex)
                .collect(),
        }))
    }

    async fn delete(
        gateway: &mut Gateway<DurableState, R2Bytes>,
        caller: Caller,
        body: &[u8],
    ) -> Result<WorkerResult<Response>, Fault> {
        let request: DeleteRequest = parse(body)?;
        let mut names = Vec::with_capacity(request.objects.len());
        for hex_text in &request.objects {
            names.push(name_of(hex_text)?);
        }
        let outcomes = gateway
            .delete(caller, &names, request.member_confirmed_shrink)
            .await?;
        Ok(Response::from_json(&DeleteResponse {
            outcomes: outcomes
                .iter()
                .map(|outcome| DeleteOutcomeBody {
                    object: outcome.name.hex(),
                    // A PARTIAL DELETE IS REPORTED, NOT ROLLED BACK: the phone
                    // asked for a set and the honest answer is which members of it
                    // were kept and why. The reason word is `gateway-core`'s.
                    refused: centraid_gateway_core::engine::refusal_reason(outcome.verdict)
                        .map(|reason| format!("{reason:?}")),
                })
                .collect(),
        }))
    }

    async fn generations(
        gateway: &mut Gateway<DurableState, R2Bytes>,
        caller: Caller,
    ) -> Result<WorkerResult<Response>, Fault> {
        let state = gateway.vault(&caller.vault).await?;
        state.plan.authorize_read().map_err(Fault::Refused)?;
        let objects = gateway.state.objects(&caller.vault).await?;
        Ok(Response::from_json(&GenerationsResponse {
            head: state.head.map(|head| head.hex()),
            objects: objects
                .iter()
                .map(|object| ObjectBody {
                    name: object.name.hex(),
                    kind: object.kind.as_str().to_owned(),
                    padded_size: object.padded_size,
                    generation: object.generation.as_str().to_owned(),
                    received_at_ms: object.received_at.millis(),
                })
                .collect(),
        }))
    }

    // ----------------------------------------------------- the mailbox object --

    /// ONE DURABLE OBJECT PER MAILBOX, with an alarm for the TTL.
    #[durable_object]
    pub struct MailboxObject {
        state: State,
        /// Handed over by [`DurableObject::new`], which every object's constructor
        /// takes whether it reads it or not.
        ///
        /// **A mailbox needs nothing from the environment**, and that is a property
        /// worth keeping rather than an omission: it holds no bucket, no S3
        /// credential and no plan table, so a misconfigured deployment cannot make
        /// a mailbox behave differently from a correctly configured one. If a
        /// binding ever arrives here, that sentence stops being true.
        #[expect(dead_code, reason = "see above: a mailbox reads no configuration")]
        env: Env,
    }

    impl DurableObject for MailboxObject {
        fn new(state: State, env: Env) -> Self {
            Self { state, env }
        }

        async fn fetch(&self, mut request: Request) -> WorkerResult<Response> {
            let at = now();
            let url = request.url()?;
            let segments: Vec<String> = url
                .path_segments()
                .map(|segments| segments.map(str::to_owned).collect())
                .unwrap_or_default();
            let Some(mailbox) = segments.get(1).and_then(|hex| key_of(hex)) else {
                return refused(&Refusal::UnknownVault, at.millis());
            };
            let method = request.method();
            let body = request.bytes().await.unwrap_or_default();
            let store = match MailboxStore::open(self.state.storage().sql(), mailbox) {
                Ok(store) => store,
                Err(fault) => return wire::internal(&fault.0, at.millis()),
            };

            match (method, segments.get(2).map(String::as_str)) {
                // A DEPOSIT IS NOT SIGNED BY THE SENDER. Authorisation is the
                // capability the recipient issued; the sender's own signature is
                // inside the sealed bundle, where only the recipient can read it.
                // So this gateway never learns who is writing, and there is nowhere
                // for it to record one.
                (Method::Post, Some("deposit")) => {
                    let Ok(deposit) = serde_json::from_slice::<DepositRequest>(&body) else {
                        return refused(&Refusal::SignatureInvalid, at.millis());
                    };
                    let (Some(capability_id), Some(entry_id)) =
                        (key_of(&deposit.capability_id), key_of(&deposit.entry_id))
                    else {
                        return refused(&Refusal::SignatureInvalid, at.millis());
                    };
                    let capability = match store.capability(capability_id) {
                        Ok(Some(capability)) => capability,
                        // A capability this mailbox never issued and one that was
                        // revoked get the same refusal, for the reason a stranger
                        // and an unknown vault do.
                        Ok(None) => {
                            return refused(
                            &Refusal::MailboxRefused(
                                centraid_gateway_core::error::MailboxFault::NotIssuedByRecipient,
                            ),
                            at.millis(),
                        );
                        }
                        Err(fault) => return wire::internal(&fault.0, at.millis()),
                    };
                    match store.deposit(&capability, entry_id, deposit.sealed_bytes, at) {
                        Ok(Ok(entry)) => {
                            // ARM THE ALARM FOR THE EARLIEST EXPIRY. One alarm per
                            // mailbox, not one per entry: an alarm per deposit would
                            // be a wake-up per deposit on an object that can take
                            // thousands.
                            self.arm(entry.expires_at).await?;
                            Response::from_json(&DepositResponse {
                                expires_at_ms: entry.expires_at.millis(),
                            })
                        }
                        Ok(Err(refusal)) => refused(&refusal, at.millis()),
                        Err(fault) => wire::internal(&fault.0, at.millis()),
                    }
                }
                (Method::Get, Some("drain")) => match store.drain(at) {
                    Ok(entries) => Response::from_json(&DrainResponse {
                        entries: entries
                            .iter()
                            .map(|entry| EntryBody {
                                entry_id: entry.entry_id.hex(),
                                deposited_at_ms: entry.deposited_at.millis(),
                                expires_at_ms: entry.expires_at.millis(),
                                sealed_bytes: entry.sealed_bytes,
                            })
                            .collect(),
                    }),
                    Err(fault) => wire::internal(&fault.0, at.millis()),
                },
                (Method::Post, Some("ack")) => {
                    let Some(entry_id) = segments.get(3).and_then(|hex| key_of(hex)) else {
                        return refused(&Refusal::SignatureInvalid, at.millis());
                    };
                    match store.ack(entry_id) {
                        Ok(()) => Response::empty().map(|response| response.with_status(204)),
                        Err(fault) => wire::internal(&fault.0, at.millis()),
                    }
                }
                _ => Response::error("not found", 404),
            }
        }

        /// THE TTL, WHEN NOTHING ELSE IS TOUCHING THIS MAILBOX.
        ///
        /// A Worker is not a process with a timer in it, so a sweep has nowhere to
        /// run; a Durable Object alarm is the runtime's answer. The rule is still
        /// `mailbox::expired`, which the standalone adapter's sweep also asks —
        /// **the alarm is a mechanism for reaching the rule, not a second copy of
        /// it**, and that distinction is the difference between two deployments
        /// that agree about a TTL and two that drift by however long a sweep takes.
        async fn alarm(&self) -> WorkerResult<Response> {
            let at = now();
            // The mailbox key is this object's own name, which is how it was routed
            // to. An alarm arrives with no request, so there is no path to read it
            // from.
            let Some(mailbox) = self
                .state
                .id()
                .name()
                .as_deref()
                .and_then(|name| key_of(name))
            else {
                return Response::ok("no mailbox name");
            };
            let store = match MailboxStore::open(self.state.storage().sql(), mailbox) {
                Ok(store) => store,
                Err(fault) => return Response::error(fault.0, 500),
            };
            match store.expire_and_next(at) {
                Ok(Some(next)) => {
                    self.arm(next).await?;
                    Response::ok("swept")
                }
                // EMPTY: the alarm is cleared rather than re-armed for a far-off
                // instant. An object that keeps waking to find nothing is an object
                // that costs money to hold nothing.
                Ok(None) => {
                    self.state.storage().delete_alarm().await?;
                    Response::ok("empty")
                }
                Err(fault) => Response::error(fault.0, 500),
            }
        }
    }

    impl MailboxObject {
        /// Arm the alarm for `at`, unless an earlier one is already set.
        async fn arm(&self, at: ServerTime) -> WorkerResult<()> {
            let storage = self.state.storage();
            if let Ok(Some(existing)) = storage.get_alarm().await
                && existing <= at.millis()
            {
                return Ok(());
            }
            storage.set_alarm(delay_until(at.millis())).await
        }
    }

    /// `ScheduledTime` takes a delay from now.
    ///
    /// A negative one is an instant already past, which the runtime answers by
    /// firing immediately — the correct behaviour for an entry that expired while
    /// nothing was looking.
    fn delay_until(millis: i64) -> std::time::Duration {
        let delay = millis - worker::Date::now().as_millis() as i64;
        std::time::Duration::from_millis(delay.max(0) as u64)
    }

    // ----------------------------------------------------- the account object --

    /// ONE DURABLE OBJECT PER ACCOUNT: the vault listing a restored phone reads,
    /// and the purchase map.
    ///
    /// **Admission is the one place the two deployments differ** and it ends in the
    /// same state either way. Nothing downstream of this object knows it exists.
    #[durable_object]
    pub struct AccountObject {
        state: State,
        env: Env,
    }

    impl DurableObject for AccountObject {
        fn new(state: State, env: Env) -> Self {
            Self { state, env }
        }

        async fn fetch(&self, mut request: Request) -> WorkerResult<Response> {
            let at = now();
            let url = request.url()?;
            let segments: Vec<String> = url
                .path_segments()
                .map(|segments| segments.map(str::to_owned).collect())
                .unwrap_or_default();
            let Some(account) = segments.get(1).and_then(|hex| key_of(hex)) else {
                return refused(&Refusal::UnknownVault, at.millis());
            };
            let method = request.method();
            let body = request.bytes().await.unwrap_or_default();
            let store = match AccountStore::open(self.state.storage().sql()) {
                Ok(store) => store,
                Err(fault) => return wire::internal(&fault.0, at.millis()),
            };

            match (method, segments.get(2).map(String::as_str)) {
                // What a restored phone reads to find its vaults, with no operator
                // involved (§0).
                (Method::Get, Some("vaults")) => match store.vaults(&account) {
                    Ok(vaults) => Response::from_json(&VaultsResponse {
                        vaults: vaults
                            .iter()
                            .map(|(vault, registered)| VaultListing {
                                vault: vault.hex(),
                                registered_at_ms: *registered,
                            })
                            .collect(),
                    }),
                    Err(fault) => wire::internal(&fault.0, at.millis()),
                },
                // A TOKEN TO HAND STOREKIT. Random and meaningless: the store
                // learns a UUID that says nothing, and the mapping back to the
                // account key stays here (`accounts.rs`).
                (Method::Post, Some("purchase-token")) => {
                    let token = random_uuid();
                    if token.is_empty() {
                        return Response::error("no platform generator", 500);
                    }
                    match store.mint_token(&account, &token, at) {
                        Ok(()) => Response::from_json(&TokenResponse { token }),
                        Err(fault) => wire::internal(&fault.0, at.millis()),
                    }
                }
                // A RECEIPT, VERIFIED WITH THE STORE AND NEVER STORED.
                (Method::Post, Some("receipt")) => {
                    self.verify_receipt(&store, account, &body, at).await
                }
                _ => Response::error("not found", 404),
            }
        }
    }

    impl AccountObject {
        async fn verify_receipt(
            &self,
            store: &AccountStore,
            account: Key32,
            body: &[u8],
            at: ServerTime,
        ) -> WorkerResult<Response> {
            let Ok(submitted) = serde_json::from_slice::<ReceiptRequest>(body) else {
                return refused(&Refusal::SignatureInvalid, at.millis());
            };
            let Ok(verify_url) = self.env.var(match submitted.store {
                accounts::Store::AppStore => "APP_STORE_VERIFY_URL",
                accounts::Store::Play => "PLAY_VERIFY_URL",
            }) else {
                // NOT CONFIGURED IS A REFUSAL, NOT A GRANT. A Worker that trusted
                // the client's own copy of a store's answer would sell
                // subscriptions to anyone who could type JSON.
                return Response::error("this deployment cannot verify that store", 501);
            };

            // The receipt goes to the store and NOT into this object's storage: it
            // is a bearer credential for somebody's store account. What is kept is
            // its BLAKE3, so a replay is recognised.
            let mut init = worker::RequestInit::new();
            init.with_method(Method::Post)
                .with_body(Some(submitted.receipt.clone().into()));
            let verify = Request::new_with_init(&verify_url.to_string(), &init)?;
            let mut answer = worker::Fetch::Request(verify).send().await?;
            if answer.status_code() >= 400 {
                return Response::error("the store did not verify that receipt", 402);
            }
            let response: accounts::StoreResponse = match answer.json().await {
                Ok(response) => response,
                Err(error) => {
                    worker::console_error!("the store's answer did not parse: {error}");
                    return Response::error("the store's answer did not parse", 502);
                }
            };

            let config = plan_config(&self.env);
            let verified = match accounts::interpret(submitted.store, &response, &config) {
                Ok(verified) => verified,
                Err(fault) => return Response::error(fault.to_string(), 402),
            };
            // THE TOKEN MUST BE THIS ACCOUNT'S. A receipt naming somebody else's
            // token is somebody else's purchase, and the refusal is the same one a
            // token that never existed gets.
            match store.account_for_token(&verified.token) {
                Ok(Some(named)) if named == account => {}
                Ok(_) => return Response::error("that purchase token is not this account's", 403),
                Err(fault) => return wire::internal(&fault.0, at.millis()),
            }

            let receipt_hash = *blake3::hash(submitted.receipt.as_bytes()).as_bytes();
            if let Err(fault) = store.record_receipt(&account, &receipt_hash, &verified, at) {
                return wire::internal(&fault.0, at.millis());
            }
            match store.plan(&account, 0, &config, at) {
                Ok(plan) => Response::from_json(&PlanResponse {
                    // A STATE AND A NUMBER OF BYTES. No price and no plan name: Q15
                    // and Q16 are open and this route does not decide them.
                    state: format!("{:?}", plan.state),
                    quota_bytes: plan.quota_bytes,
                    retain_until_ms: plan.retain_until.map(ServerTime::millis),
                }),
                Err(fault) => wire::internal(&fault.0, at.millis()),
            }
        }
    }

    /// A UUID from the platform's generator.
    ///
    /// **Not derived from the account key.** A derivation would let anyone who
    /// learned the rule link the store's records back to an account, which is the
    /// opposite of what an opaque handle is for. Randomness is the platform's, for
    /// the same reason `gateway-core` has none of its own.
    fn random_uuid() -> String {
        let global = worker::js_sys::global();
        worker::js_sys::Reflect::get(&global, &"crypto".into())
            .ok()
            .and_then(|crypto| {
                worker::js_sys::Reflect::get(&crypto, &"randomUUID".into())
                    .ok()
                    .and_then(|function| function.dyn_into::<worker::js_sys::Function>().ok())
                    .and_then(|function| function.call0(&crypto).ok())
                    .and_then(|value| value.as_string())
            })
            .unwrap_or_default()
    }

    // ------------------------------------------------------------ wire bodies --

    fn parse<T: for<'a> Deserialize<'a>>(body: &[u8]) -> Result<T, Fault> {
        serde_json::from_slice(body).map_err(|_| Fault::Refused(Refusal::SignatureInvalid))
    }

    fn name_of(hex_text: &str) -> Result<ObjectName, Fault> {
        key_of(hex_text).ok_or(Fault::Refused(Refusal::SignatureInvalid))
    }

    #[derive(Debug, Deserialize)]
    struct DeclareRequest {
        objects: Vec<DeclaredObject>,
    }

    #[derive(Debug, Deserialize)]
    struct DeclaredObject {
        name: String,
        attested_checksum: String,
        kind: String,
        padded_size: u64,
    }

    impl DeclaredObject {
        fn parse(&self) -> Result<Declaration, Fault> {
            let name = name_of(&self.name)?;
            let checksum = hex::decode(&self.attested_checksum)
                .ok()
                .and_then(|bytes| {
                    centraid_gateway_core::checksum::AttestedChecksum::from_slice(&bytes)
                })
                .ok_or(Fault::Refused(Refusal::SignatureInvalid))?;
            let kind = [
                ObjectKind::Base,
                ObjectKind::Segment,
                ObjectKind::Manifest,
                ObjectKind::Blob,
                ObjectKind::Pack,
                ObjectKind::ShareEntry,
            ]
            .into_iter()
            .find(|kind| kind.as_str() == self.kind)
            .ok_or(Fault::Refused(Refusal::SignatureInvalid))?;
            Ok(Declaration {
                name,
                checksum,
                kind,
                padded_size: self.padded_size,
            })
        }
    }

    #[derive(Debug, Serialize)]
    struct DeclareResponse {
        targets: Vec<TargetBody>,
    }

    #[derive(Debug, Serialize)]
    struct TargetBody {
        name: String,
        url: String,
        expires_at_ms: i64,
        already_committed: bool,
    }

    #[derive(Debug, Deserialize)]
    struct CommitRequest {
        generation: String,
        objects: Vec<String>,
        manifest_head: String,
        prev_head: Option<String>,
        first_txid: u64,
        last_txid: u64,
    }

    impl CommitRequest {
        fn parse(&self) -> Result<CommitInput, Fault> {
            let generation = Generation::parse(&self.generation)
                .ok_or(Fault::Refused(Refusal::MalformedGeneration))?;
            let mut objects = Vec::with_capacity(self.objects.len());
            for hex_text in &self.objects {
                objects.push(name_of(hex_text)?);
            }
            let prev_head = match &self.prev_head {
                Some(hex_text) => Some(name_of(hex_text)?),
                None => None,
            };
            Ok(CommitInput {
                generation,
                objects,
                manifest_head: name_of(&self.manifest_head)?,
                prev_head,
                first_txid: self.first_txid,
                last_txid: self.last_txid,
            })
        }
    }

    #[derive(Debug, Serialize)]
    struct CommitResponse {
        head: String,
        committed_at_ms: i64,
        already_committed: Vec<String>,
    }

    #[derive(Debug, Deserialize)]
    struct DeleteRequest {
        objects: Vec<String>,
        #[serde(default)]
        member_confirmed_shrink: bool,
    }

    #[derive(Debug, Serialize)]
    struct DeleteResponse {
        outcomes: Vec<DeleteOutcomeBody>,
    }

    #[derive(Debug, Serialize)]
    struct DeleteOutcomeBody {
        object: String,
        refused: Option<String>,
    }

    #[derive(Debug, Serialize)]
    struct GenerationsResponse {
        head: Option<String>,
        objects: Vec<ObjectBody>,
    }

    #[derive(Debug, Serialize)]
    struct ObjectBody {
        name: String,
        kind: String,
        padded_size: u64,
        generation: String,
        received_at_ms: i64,
    }

    #[derive(Debug, Serialize)]
    struct ReadResponse {
        url: String,
    }

    #[derive(Debug, Serialize)]
    struct LeaseBody {
        epoch: u64,
        head: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    struct DepositRequest {
        capability_id: String,
        entry_id: String,
        sealed_bytes: u64,
    }

    #[derive(Debug, Serialize)]
    struct DepositResponse {
        expires_at_ms: i64,
    }

    #[derive(Debug, Serialize)]
    struct DrainResponse {
        entries: Vec<EntryBody>,
    }

    /// One entry, as a recipient reads it. **No sender**, because this gateway
    /// never learned one.
    #[derive(Debug, Serialize)]
    struct EntryBody {
        entry_id: String,
        deposited_at_ms: i64,
        expires_at_ms: i64,
        sealed_bytes: u64,
    }

    #[derive(Debug, Serialize)]
    struct VaultsResponse {
        vaults: Vec<VaultListing>,
    }

    #[derive(Debug, Serialize)]
    struct VaultListing {
        vault: String,
        registered_at_ms: i64,
    }

    #[derive(Debug, Serialize)]
    struct TokenResponse {
        token: String,
    }

    #[derive(Debug, Deserialize)]
    struct ReceiptRequest {
        store: accounts::Store,
        /// The receipt as the store issued it. **Forwarded and then dropped**: it is
        /// a bearer credential and nothing here keeps a copy.
        receipt: String,
    }

    #[derive(Debug, Serialize)]
    struct PlanResponse {
        state: String,
        quota_bytes: u64,
        retain_until_ms: Option<i64>,
    }
}
