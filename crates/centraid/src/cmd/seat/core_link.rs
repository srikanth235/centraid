//! The core thread, and the only way the socket reaches it.
//!
//! `centraid_core::Handle` holds a `Mutex<Vault>` over a vault that is `!Sync`
//! by construction — the commit-guard depth is a `Cell`, deliberately, because
//! the depth is a fact about one connection (`crates/core/src/handle.rs:6`–
//! `:31`). So the handle cannot be shared across tasks at all, and
//! [`Handle::call`] blocks by design ("synchronous from the caller's view, and
//! never from a UI thread").
//!
//! Both facts point at the same shape and it is the one the core's own
//! documentation names: **one core thread**, owning the handle, fed by a
//! channel. Every socket connection is a task that sends a request and awaits
//! a reply; the thread also drains the core's event queue and republishes what
//! it finds, because `next_event` blocks too and the handle it blocks on is the
//! same one.
//!
//! What this is *not* is a work queue with a pool: there is one vault, one
//! writable connection and one mutex behind it, so a pool would be threads
//! queueing on a lock. The serialisation is the vault's, and `crates/core`'s
//! D-1020-D2-9 already rules on it — a reader pool is lane D1's file.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig};
use tokio::sync::{broadcast, mpsc, oneshot};

/// One unit of work for the core thread.
enum Job {
    /// Answer a request under an id the caller minted.
    Call {
        request: wire::Request,
        request_id: u64,
        reply: oneshot::Sender<Result<wire::Response, String>>,
    },
    /// Answer a request, letting the core mint the id.
    CallLocal {
        request: wire::Request,
        reply: oneshot::Sender<Result<wire::Response, String>>,
    },
    /// Cancel an in-flight unbounded operation.
    Cancel { request_id: u64 },
    /// Close the handle and stop the thread.
    Close { reply: oneshot::Sender<()> },
}

/// How many events the republisher will hold for slow subscribers.
///
/// Smaller than the core's own `EVENT_QUEUE_CAP` on purpose: the core's queue
/// must never drop (a dropped change event is a screen that stays wrong), and
/// it does not — it stalls. This one is a *fan-out* buffer for connections that
/// are already behind, and a connection that cannot keep up with 256 events is
/// told it lagged rather than held in front of the core's queue.
const FANOUT_CAP: usize = 256;

/// The socket's end of the core thread.
#[derive(Debug)]
pub struct CoreLink {
    jobs: mpsc::Sender<Job>,
    events: broadcast::Sender<wire::Event>,
    thread: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl CoreLink {
    /// Open the core on its own thread.
    ///
    /// Opening happens **on that thread** rather than here and being moved:
    /// `Handle` is not `Send`, so there is nothing to move.
    pub async fn open(config: CoreConfig) -> Result<Self, String> {
        let (jobs, mut inbox) = mpsc::channel::<Job>(64);
        let (events, _) = broadcast::channel::<wire::Event>(FANOUT_CAP);
        let (opened, opened_rx) = oneshot::channel::<Result<(), String>>();
        let publisher = events.clone();

        let thread = std::thread::Builder::new()
            .name("centraid-core".to_owned())
            .spawn(move || {
                let handle = match Core::open(config) {
                    Ok(handle) => {
                        let _ = opened.send(Ok(()));
                        handle
                    }
                    Err(error) => {
                        let _ = opened.send(Err(error.to_string()));
                        return;
                    }
                };
                loop {
                    // A SHORT EVENT WAIT BETWEEN JOBS, not a second thread.
                    // `next_event` and `call` both want the same handle, so
                    // they take turns: 20 ms is below a frame at 30 fps, so a
                    // change event reaches the shell inside the frame it would
                    // have been drawn in anyway.
                    match inbox.try_recv() {
                        Ok(job) => {
                            if run(&handle, job) {
                                break;
                            }
                        }
                        Err(mpsc::error::TryRecvError::Disconnected) => break,
                        Err(mpsc::error::TryRecvError::Empty) => {
                            match handle.next_event(Duration::from_millis(20)) {
                                Ok(Some(event)) => {
                                    // A send with no subscribers is not an
                                    // error: a seat with no window open still
                                    // syncs, and the events it produces are
                                    // simply nobody's yet.
                                    let _ = publisher.send(event);
                                }
                                Ok(None) => {}
                                Err(_) => break,
                            }
                        }
                    }
                }
                handle.close();
            })
            .map_err(|error| format!("the core thread would not start: {error}"))?;

        match opened_rx.await {
            Ok(Ok(())) => Ok(Self {
                jobs,
                events,
                thread: std::sync::Mutex::new(Some(thread)),
            }),
            Ok(Err(error)) => Err(error),
            Err(_) => Err("the core thread stopped before it opened the vault".to_owned()),
        }
    }

    /// Answer a request under the peer's own request id (the core channel).
    pub async fn call_with_id(
        &self,
        request: wire::Request,
        request_id: u64,
    ) -> Result<wire::Response, String> {
        let (reply, answer) = oneshot::channel();
        self.jobs
            .send(Job::Call {
                request,
                request_id,
                reply,
            })
            .await
            .map_err(|_| "the core thread has stopped".to_owned())?;
        answer
            .await
            .map_err(|_| "the core thread dropped a request".to_owned())?
    }

    /// Answer a request the sidecar itself is making (the local channel and the
    /// blob door), letting the core mint the id.
    pub async fn call(&self, request: wire::Request) -> Result<wire::Response, String> {
        let (reply, answer) = oneshot::channel();
        self.jobs
            .send(Job::CallLocal { request, reply })
            .await
            .map_err(|_| "the core thread has stopped".to_owned())?;
        answer
            .await
            .map_err(|_| "the core thread dropped a request".to_owned())?
    }

    pub async fn cancel(&self, request_id: u64) {
        let _ = self.jobs.send(Job::Cancel { request_id }).await;
    }

    /// A new subscription to the core's events.
    pub fn subscribe(&self) -> broadcast::Receiver<wire::Event> {
        self.events.subscribe()
    }

    /// Close the core and **wait for it**.
    ///
    /// Awaited, not fired and forgotten: this is the `close` the desktop's quit
    /// path waits for before it signals the process (D-1020-F1), and the whole
    /// point is that the vault's last write has landed before anything sends a
    /// signal at it.
    pub async fn close(&self) {
        let (reply, closed) = oneshot::channel();
        if self.jobs.send(Job::Close { reply }).await.is_ok() {
            let _ = closed.await;
        }
        let joinable = self
            .thread
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(thread) = joinable {
            // On a blocking pool thread: joining a thread from the reactor
            // would block the runtime, and this join is the one that proves
            // the vault closed.
            let _ = tokio::task::spawn_blocking(move || thread.join()).await;
        }
    }
}

/// Run one job. Returns `true` when the thread should stop.
fn run(handle: &centraid_core::Handle, job: Job) -> bool {
    match job {
        Job::Call {
            request,
            request_id,
            reply,
        } => {
            let answer = handle
                .call_with_id(&request, request_id)
                .map_err(|error| error.to_string());
            let _ = reply.send(answer);
            false
        }
        Job::CallLocal { request, reply } => {
            let answer = handle.call(&request).map_err(|error| error.to_string());
            let _ = reply.send(answer);
            false
        }
        Job::Cancel { request_id } => {
            // A refusal is a fact about the request ("a bounded read is not
            // cancellable"), not about the link, so it is logged and the loop
            // continues.
            if let Err(error) = handle.cancel(request_id) {
                tracing::debug!(request_id, %error, "a cancel was refused");
            }
            false
        }
        Job::Close { reply } => {
            handle.close();
            let _ = reply.send(());
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(path: &std::path::Path) -> CoreConfig {
        CoreConfig {
            create: true,
            ..CoreConfig::gateway(path)
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_handshake_crosses_the_thread_and_the_close_is_awaited() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let link = CoreLink::open(config(&dir.path().join("vault.db")))
            .await
            .expect("the core opened");

        let hello = wire::Request {
            kind: Some(wire::request::Kind::Hello(wire::Hello {
                identity: None,
                schema_version: 1,
                min_supported: 1,
                product_version: "test".to_owned(),
                capabilities: Vec::new(),
            })),
        };
        let answer = link.call(hello).await.expect("a hello is answered");
        assert!(matches!(answer.kind, Some(wire::response::Kind::Hello(_))));

        link.close().await;
        // AFTER CLOSE the link answers with a reason rather than hanging: the
        // desktop's quit path races this against a signal, and a hang there is
        // a five-second wait on every quit.
        let error = link
            .call(wire::Request { kind: None })
            .await
            .expect_err("a closed link refuses");
        assert!(!error.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_vault_that_will_not_open_is_a_reason_and_not_a_thread_left_running() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let path = dir.path().join("nothing").join("vault.db");
        let error = CoreLink::open(CoreConfig {
            create: false,
            ..CoreConfig::gateway(&path)
        })
        .await
        .expect_err("a missing vault is refused");
        assert!(!error.is_empty(), "the refusal carries a reason");
    }
}
