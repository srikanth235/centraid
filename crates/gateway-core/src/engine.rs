//! The order the rules run in (#1029 §3).
//!
//! Each module in this crate answers one question. This one answers *in what
//! order*, which is a rule of its own and the one an adapter is most likely to
//! get subtly wrong on its own: checking the quota after issuing the presigned
//! URL, or the lease after recording the object, gives the same answers on the
//! happy path and different ones everywhere else.
//!
//! **There is no `GatewayMode` here.** What differs between the two deployments
//! is behind [`ByteStore`] and [`StateStore`], and the one honest difference —
//! which checksum evidence the store can produce — is a property of the store
//! the adapter was pointed at.

use crate::checksum::{self, ChecksumFault};
use crate::error::Refusal;
use crate::ids::{DeviceId, Generation, ObjectKind, ObjectName, VaultId};
use crate::lease;
use crate::retention::{self, BaseRecord, DeleteCandidate, DeleteContext, DeleteRefusal, Verdict};
use crate::scrub;
use crate::store::{
    ByteStore, ObjectState, StateStore, StoreFault, StoredObject, UploadTarget, VaultState,
};
use crate::time::ServerTime;
use crate::upload::{self, Declaration, Disposition};

/// A request that failed, and which half failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Fault {
    /// A rule said no. The phone gets a typed code.
    #[error(transparent)]
    Refused(#[from] Refusal),
    /// A store failed. The phone gets an internal error and retries.
    #[error(transparent)]
    Store(#[from] StoreFault),
}

/// Who is asking, as the adapter has already authenticated them.
///
/// The certificate has been decoded and verified and the request signature
/// checked ([`crate::auth`]); what remains is *authorisation*, which is this
/// crate's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caller {
    pub vault: VaultId,
    pub device: DeviceId,
    /// The epoch the caller's certificate names.
    pub epoch: u64,
    pub now: ServerTime,
}

/// What a commit says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitInput {
    pub generation: Generation,
    pub objects: Vec<ObjectName>,
    pub manifest_head: ObjectName,
    /// **The head this writer last saw.** `None` is "no head yet", and it is a
    /// different claim (F7).
    pub prev_head: Option<ObjectName>,
    pub first_txid: u64,
    pub last_txid: u64,
}

/// What a commit did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitOutcome {
    pub head: ObjectName,
    pub committed_at: ServerTime,
    /// Objects that were already committed by an earlier identical request.
    pub already_committed: Vec<ObjectName>,
}

/// One object's delete verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeleteOutcome {
    pub name: ObjectName,
    pub verdict: Verdict,
}

/// The rules, over one adapter's storage.
#[derive(Debug)]
pub struct Gateway<S, B> {
    pub state: S,
    pub bytes: B,
    pub retention: retention::Policy,
}

impl<S: StateStore, B: ByteStore> Gateway<S, B> {
    /// Build one over an adapter's stores.
    pub const fn new(state: S, bytes: B, retention: retention::Policy) -> Self {
        Self {
            state,
            bytes,
            retention,
        }
    }

    /// Look the vault up, or refuse.
    ///
    /// **A stranger and an unregistered vault are the same refusal.** A gateway
    /// that distinguished them would answer "does this identity key have a
    /// vault here?" for anyone who asked, which is the enumeration oracle the
    /// whole addressing scheme exists to avoid.
    ///
    /// # Errors
    ///
    /// [`Refusal::UnknownVault`], or a store fault.
    pub async fn vault(&self, vault: &VaultId) -> Result<VaultState, Fault> {
        self.state
            .vault(vault)
            .await?
            .ok_or(Fault::Refused(Refusal::UnknownVault))
    }

    /// Take the lease at `caller.epoch`.
    ///
    /// # Errors
    ///
    /// [`Refusal::LeaseStale`] for an epoch at or below the one held.
    pub async fn claim_lease(&mut self, caller: Caller) -> Result<VaultState, Fault> {
        let mut state = self.vault(&caller.vault).await?;
        state.lease = lease::claim(state.lease, caller.epoch, caller.device, caller.now)?;
        self.state.put_vault(&state).await?;
        Ok(state)
    }

    /// Declare objects and receive an upload target for each.
    ///
    /// The order is the rule: **lease, then plan, then quota, then the
    /// per-object checks, and only then a target.** A presigned URL for bytes
    /// the gateway will refuse is a phone spending a member's cellular data to
    /// earn a rejection.
    ///
    /// # Errors
    ///
    /// Any of [`Refusal::VaultMoved`], [`Refusal::NotLeaseHolder`],
    /// [`Refusal::PlanLapsed`], [`Refusal::QuotaExceeded`],
    /// [`Refusal::ObjectTooLarge`] or [`Refusal::Checksum`].
    pub async fn declare(
        &mut self,
        caller: Caller,
        declarations: &[Declaration],
    ) -> Result<Vec<UploadTarget>, Fault> {
        let state = self.vault(&caller.vault).await?;
        lease::authorize_write(state.lease, caller.device, caller.epoch)?;

        // The quota is judged over everything not already held: a re-declared
        // name is bytes the vault is already charged for, and charging twice
        // would make a retry over a flaky link cost a member their quota.
        let mut wanted = 0_u64;
        let mut held = Vec::with_capacity(declarations.len());
        for declaration in declarations {
            let existing = self.state.object(&caller.vault, &declaration.name).await?;
            if existing.is_none() {
                wanted = wanted.saturating_add(declaration.padded_size);
            }
            held.push(existing);
        }
        state.plan.authorize_write(wanted)?;

        let mut targets = Vec::with_capacity(declarations.len());
        for (declaration, existing) in declarations.iter().zip(held) {
            match upload::disposition(declaration, existing.as_ref())? {
                Disposition::AlreadyCommitted => targets.push(UploadTarget {
                    name: declaration.name,
                    url: String::new(),
                    expires_at: caller.now,
                    already_committed: true,
                }),
                Disposition::Presign => {
                    if existing.is_none() {
                        self.state
                            .put_object(
                                &caller.vault,
                                &StoredObject {
                                    name: declaration.name,
                                    checksum: declaration.checksum,
                                    kind: declaration.kind,
                                    padded_size: declaration.padded_size,
                                    state: ObjectState::Declared,
                                    received_at: caller.now,
                                    // A declaration does not name a generation;
                                    // the commit does. Until then the object is
                                    // filed under the zero generation, which is
                                    // not a valid client-minted id and so cannot
                                    // collide with one.
                                    generation: zero_generation(),
                                },
                            )
                            .await?;
                    }
                    targets.push(
                        self.bytes
                            .presign_put(
                                &caller.vault,
                                &declaration.name,
                                declaration.padded_size,
                                caller.now,
                            )
                            .await?,
                    );
                }
            }
        }
        Ok(targets)
    }

    /// Verify the uploaded bytes, record them, move the head, and ack.
    ///
    /// The head moves **last**, after every object has verified: a head that
    /// pointed at a manifest whose objects were refused would be a head a
    /// restore cannot follow.
    ///
    /// # Errors
    ///
    /// [`Refusal::ObjectUnknown`] for a name never declared, [`Refusal::Checksum`]
    /// for the verification, and [`Refusal::HeadConflict`] for the
    /// compare-and-set.
    pub async fn commit(
        &mut self,
        caller: Caller,
        input: &CommitInput,
    ) -> Result<CommitOutcome, Fault> {
        let state = self.vault(&caller.vault).await?;
        lease::authorize_write(state.lease, caller.device, caller.epoch)?;
        state.plan.authorize_write(0)?;

        let mode = self.bytes.checksum_mode();
        let mut verified = Vec::with_capacity(input.objects.len());
        let mut already = Vec::new();
        let mut base_objects = Vec::new();
        let mut base_bytes = 0_u64;

        for name in &input.objects {
            let held = self
                .state
                .object(&caller.vault, name)
                .await?
                .ok_or(Fault::Refused(Refusal::ObjectUnknown(*name)))?;

            if matches!(
                held.state,
                ObjectState::Committed | ObjectState::Tombstoned { .. }
            ) {
                // A retry with identical bytes is a no-op.
                already.push(*name);
                if held.kind == ObjectKind::Base {
                    base_objects.push(*name);
                    base_bytes = base_bytes.saturating_add(held.padded_size);
                }
                continue;
            }

            let evidence = self.bytes.evidence(&caller.vault, name).await?;
            checksum::verify(mode, *name, held.checksum, held.padded_size, &evidence)
                .map_err(|fault: ChecksumFault| Fault::Refused(Refusal::Checksum(fault)))?;

            if held.kind == ObjectKind::Base {
                base_objects.push(*name);
                base_bytes = base_bytes.saturating_add(held.padded_size);
            }
            verified.push(StoredObject {
                state: ObjectState::Committed,
                received_at: caller.now,
                generation: input.generation.clone(),
                ..held
            });
        }

        // THE HEAD MOVES ONLY BY COMPARE-AND-SET, and the store is what makes
        // it atomic (F7).
        let after = self
            .state
            .compare_and_set_head(&caller.vault, input.prev_head, input.manifest_head)
            .await?;
        if after != Some(input.manifest_head) {
            // The port applied `commit::compare_and_set` and the head is not
            // where this writer asked for it, so the writer lost. It is told
            // what the head is now and re-reads; it does not clobber.
            return Err(Fault::Refused(Refusal::HeadConflict { current: after }));
        }

        for object in &verified {
            self.state.put_object(&caller.vault, object).await?;
        }

        // A base is the `base`-kind objects one commit brought, grouped under
        // that commit's head — which is already a unique name and needs no
        // counter invented for it.
        if !base_objects.is_empty() {
            self.state
                .put_base(
                    &caller.vault,
                    &BaseRecord {
                        id: input.manifest_head,
                        generation: input.generation.clone(),
                        received_at: caller.now,
                        padded_size: base_bytes,
                        objects: base_objects,
                        tombstoned: false,
                    },
                )
                .await?;
        }

        let mut state = state;
        state.head = Some(input.manifest_head);
        self.state.put_vault(&state).await?;

        Ok(CommitOutcome {
            head: input.manifest_head,
            committed_at: caller.now,
            already_committed: already,
        })
    }

    /// Tombstone objects, subject to the floor, the size guard, the rate limit
    /// and the two flags.
    ///
    /// `member_confirmed_shrink` is the phone's answer to the size-guard
    /// warning, which is computed on the phone because the row census is
    /// readable only there (F4).
    ///
    /// **A partial delete is reported, not rolled back.** The phone asked for a
    /// set and the honest answer is which members of it were kept and why; a
    /// rollback would leave the phone unable to delete anything at all because
    /// one member of a batch was inside the floor.
    ///
    /// # Errors
    ///
    /// A store fault, or [`Refusal::VaultMoved`] / [`Refusal::NotLeaseHolder`].
    /// A refused *object* is a [`Verdict`] in the outcome, not an error.
    pub async fn delete(
        &mut self,
        caller: Caller,
        names: &[ObjectName],
        member_confirmed_shrink: bool,
    ) -> Result<Vec<DeleteOutcome>, Fault> {
        let state = self.vault(&caller.vault).await?;
        lease::authorize_write(state.lease, caller.device, caller.epoch)?;

        let bases = self.state.bases(&caller.vault).await?;
        let mut last_base_delete = self.state.last_client_base_delete(&caller.vault).await?;
        let mut outcomes = Vec::with_capacity(names.len());

        for name in names {
            let Some(held) = self.state.object(&caller.vault, name).await? else {
                return Err(Fault::Refused(Refusal::ObjectUnknown(*name)));
            };
            let candidate = DeleteCandidate {
                name: *name,
                kind: held.kind,
                received_at: held.received_at,
                base: bases
                    .iter()
                    .find(|base| base.objects.contains(name))
                    .map(|base| base.id),
            };
            let context = DeleteContext {
                bases: &bases,
                now: caller.now,
                policy: self.retention,
                append_only: state.append_only,
                plan_read_only: state.plan.is_read_only(),
                last_client_base_delete: last_base_delete,
                member_confirmed_shrink,
            };
            let verdict = retention::judge(&candidate, &context);
            if let Verdict::Tombstone { purge_after } = verdict {
                self.state
                    .put_object(
                        &caller.vault,
                        &StoredObject {
                            state: ObjectState::Tombstoned { purge_after },
                            ..held
                        },
                    )
                    .await?;
                if candidate.kind == ObjectKind::Base {
                    // The rate limit's memory, and it is updated INSIDE the
                    // batch: a client that asked to tombstone ten bases in one
                    // request must not get ten through a limit of one.
                    self.state
                        .record_client_base_delete(&caller.vault, caller.now)
                        .await?;
                    last_base_delete = Some(caller.now);
                }
            }
            outcomes.push(DeleteOutcome {
                name: *name,
                verdict,
            });
        }
        Ok(outcomes)
    }

    /// Purge every tombstone past its grace period. The only caller of
    /// [`ByteStore::purge`].
    ///
    /// # Errors
    ///
    /// A store fault.
    pub async fn purge(
        &mut self,
        vault: &VaultId,
        now: ServerTime,
    ) -> Result<Vec<ObjectName>, Fault> {
        let mut purged = Vec::new();
        for object in self.state.objects(vault).await? {
            let ObjectState::Tombstoned { purge_after } = object.state else {
                continue;
            };
            if retention::purgeable(purge_after, now) {
                self.bytes.purge(vault, &object.name).await?;
                purged.push(object.name);
            }
        }
        Ok(purged)
    }

    /// Re-hash every stored object and report what no longer hashes to its
    /// name. **No key is involved**, which is the whole reason a blind gateway
    /// can do this at all.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub async fn scrub(&self, vault: &VaultId) -> Result<scrub::Report, Fault> {
        let mut report = scrub::Report::default();
        for object in self.state.objects(vault).await? {
            let stored = self.bytes.read(vault, &object.name).await?;
            let finding = scrub::examine(object.name, stored.as_deref());
            report.record(object.name, finding);
        }
        Ok(report)
    }
}

/// The generation an object is filed under between its declaration and its
/// commit.
///
/// All zeroes, which [`Generation::parse`] accepts as hex and no phone mints:
/// a 128-bit random id is all zeroes with probability that is not worth a
/// branch. It exists so the column is never null in either adapter's schema.
#[must_use]
pub fn zero_generation() -> Generation {
    Generation::parse("00000000000000000000000000000000").expect("32 hex zeroes")
}

/// The wire's delete-refusal reason for a verdict.
#[must_use]
pub const fn refusal_reason(
    verdict: Verdict,
) -> Option<centraid_api_proto::core_v1::DeleteRefusalReason> {
    use centraid_api_proto::core_v1::DeleteRefusalReason as Reason;
    match verdict {
        Verdict::Tombstone { .. } => None,
        Verdict::Refused(refusal) => Some(match refusal {
            DeleteRefusal::RetentionFloor => Reason::RetentionFloor,
            DeleteRefusal::CoveredByBase => Reason::CoveredByBase,
            DeleteRefusal::SizeGuard => Reason::SizeGuard,
            DeleteRefusal::RateLimited { .. } => Reason::RateLimited,
            DeleteRefusal::AppendOnly => Reason::AppendOnly,
            DeleteRefusal::PlanLapsed => Reason::PlanLapsed,
        }),
    }
}
