//! The conformance suite over the real gateway, through the real client
//! (#1080).
//!
//! Each case resets to a fresh data directory and a fresh gateway from
//! `server::harness::spawn` on `127.0.0.1:0`; every protocol call is the
//! phone's client speaking TLS to it, trusting the certificate by its bytes.
//! The canary's window is the data directory itself: every file, its path
//! and its bytes, `state.db` and its WAL included.

use std::path::{Path, PathBuf};

use centraid_gateway2::client::{Client, ClientError, Destination, Put};
use centraid_gateway2::rules::bundle::Frame;
use centraid_gateway2::rules::code::Refusal;
use centraid_gateway2::rules::conformance::{self, CASES, Failure, PutAnswer, ScrubCounts, Target};
use centraid_gateway2::rules::ids::{Digest, GatewayId, Name, Secret, Token, VaultId};
use centraid_gateway2::rules::range::ByteRange;
use centraid_gateway2::rules::wire::{
    BundleAnswer, DeleteAnswer, HeadView, Info, ObjectEntry, PairRequest, Paired, SetHead,
    SnapshotView,
};
use centraid_gateway2::server::harness::{Spawned, spawn};

struct WireTarget {
    root: tempfile::TempDir,
    generation: u32,
    spawned: Option<Spawned>,
}

impl WireTarget {
    fn spawned(&self) -> &Spawned {
        self.spawned.as_ref().expect("reset before use")
    }

    /// A phone holding `token`, trusting the gateway by its certificate.
    fn phone(&self, token: &Token) -> Client {
        let spawned = self.spawned();
        Client::new(&Destination {
            addrs: vec![spawned.addr.to_string()],
            cert_der: spawned.cert_der.clone(),
            token: *token,
        })
    }

    /// A phone with no token yet: what pairs.
    fn stranger(&self) -> Client {
        self.spawned().first_contact()
    }
}

fn failure(error: ClientError) -> Failure {
    match error {
        ClientError::Refused(refusal) => Failure::Refused(refusal),
        other => Failure::Broken(other.to_string()),
    }
}

/// Every file under `dir`: its path relative to `dir`, then its bytes.
fn every_byte(dir: &Path) -> Vec<u8> {
    fn walk(root: &Path, dir: &Path, into: &mut Vec<u8>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
        paths.sort();
        for path in paths {
            if path.is_dir() {
                walk(root, &path, into);
            } else if let Ok(bytes) = std::fs::read(&path) {
                into.extend_from_slice(
                    path.strip_prefix(root)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .as_bytes(),
                );
                into.extend_from_slice(&bytes);
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out
}

impl Target for WireTarget {
    async fn reset(&mut self) -> Result<(), String> {
        if let Some(old) = self.spawned.take() {
            old.shutdown().await;
        }
        self.generation += 1;
        let dir = self.root.path().join(self.generation.to_string());
        self.spawned = Some(spawn(&dir).await.map_err(|error| error.to_string())?);
        Ok(())
    }

    fn gateway_id(&self) -> GatewayId {
        self.spawned().gateway_id
    }

    async fn mint_secret(&mut self) -> Result<Secret, String> {
        Ok(self.spawned().mint_pairing_secret())
    }

    async fn advance(&mut self, ms: i64) {
        self.spawned().advance_clock(ms);
    }

    async fn purge(&mut self) -> Result<u64, String> {
        self.spawned()
            .purge_now()
            .await
            .map_err(|fault| fault.to_string())
    }

    async fn scrub(&mut self) -> Result<ScrubCounts, String> {
        self.spawned()
            .scrub_now()
            .await
            .map_err(|fault| fault.to_string())
    }

    async fn corrupt(&mut self, vault: &VaultId, name: &Name) -> Result<(), String> {
        self.spawned()
            .corrupt(vault, name)
            .map_err(|error| error.to_string())
    }

    async fn at_rest(&mut self) -> Result<Vec<u8>, String> {
        Ok(every_byte(self.spawned().data_dir()))
    }

    async fn info(&mut self) -> Result<Info, Failure> {
        self.stranger().info().await.map_err(failure)
    }

    async fn pair(&mut self, request: &PairRequest) -> Result<Paired, Failure> {
        self.stranger().pair(request).await.map_err(failure)
    }

    async fn head(&mut self, token: &Token, vault: &VaultId) -> Result<HeadView, Failure> {
        self.phone(token).head(vault).await.map_err(failure)
    }

    async fn set_head(
        &mut self,
        token: &Token,
        vault: &VaultId,
        request: &SetHead,
    ) -> Result<HeadView, Failure> {
        self.phone(token)
            .set_head(vault, request)
            .await
            .map_err(failure)
    }

    async fn snapshots(
        &mut self,
        token: &Token,
        vault: &VaultId,
    ) -> Result<Vec<SnapshotView>, Failure> {
        self.phone(token).snapshots(vault).await.map_err(failure)
    }

    async fn exists(
        &mut self,
        token: &Token,
        vault: &VaultId,
        names: &[Name],
    ) -> Result<Vec<Name>, Failure> {
        self.phone(token)
            .exists(vault, names)
            .await
            .map_err(failure)
    }

    async fn put(
        &mut self,
        token: &Token,
        vault: &VaultId,
        name: &Name,
        digest: &Digest,
        bytes: &[u8],
    ) -> Result<PutAnswer, Failure> {
        // The client counts NAME_TAKEN as an acknowledgement; the suite
        // judges the protocol, where it is a 409 refusal carrying the held
        // digest, so it is turned back into one here.
        match self
            .phone(token)
            .put(vault, name, digest, bytes.to_vec())
            .await
            .map_err(failure)?
        {
            Put::Stored(entry) => Ok(PutAnswer::Stored(entry)),
            Put::AlreadyStored(entry) => Ok(PutAnswer::AlreadyStored(entry)),
            Put::NameTaken { held } => Err(Failure::Refused(Refusal::NameTaken { digest: held })),
        }
    }

    async fn get(
        &mut self,
        token: &Token,
        vault: &VaultId,
        name: &Name,
        range: Option<ByteRange>,
    ) -> Result<Vec<u8>, Failure> {
        self.phone(token)
            .get(vault, name, range)
            .await
            .map_err(failure)
    }

    async fn stat(
        &mut self,
        token: &Token,
        vault: &VaultId,
        name: &Name,
    ) -> Result<(u64, Digest), Failure> {
        let stat = self.phone(token).stat(vault, name).await.map_err(failure)?;
        Ok((stat.size, stat.digest))
    }

    async fn bundle(
        &mut self,
        token: &Token,
        vault: &VaultId,
        frames: &[Frame],
    ) -> Result<BundleAnswer, Failure> {
        self.phone(token)
            .bundle(vault, frames)
            .await
            .map_err(failure)
    }

    async fn fetch(
        &mut self,
        token: &Token,
        vault: &VaultId,
        names: &[Name],
    ) -> Result<Vec<Frame>, Failure> {
        self.phone(token).fetch(vault, names).await.map_err(failure)
    }

    async fn objects(
        &mut self,
        token: &Token,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<ObjectEntry>, Failure> {
        self.phone(token)
            .objects(vault, after, limit)
            .await
            .map_err(failure)
    }

    async fn delete(
        &mut self,
        token: &Token,
        vault: &VaultId,
        names: &[Name],
    ) -> Result<DeleteAnswer, Failure> {
        self.phone(token)
            .delete(vault, names)
            .await
            .map_err(failure)
    }
}

/// Every case, over the wire, named; a failure prints which.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_real_gateway_passes_every_case_through_the_real_client() {
    let mut target = WireTarget {
        root: tempfile::tempdir().expect("a temp dir"),
        generation: 0,
        spawned: None,
    };
    let report = conformance::run(&mut target).await;
    print!("{}", report.render());
    let names: Vec<&str> = report.cases.iter().map(|case| case.name).collect();
    assert_eq!(names, CASES, "the report must name every case, in order");
    assert!(report.is_green(), "\n{}", report.render());
}
