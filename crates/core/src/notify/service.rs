//! THE SERVICE ON A CORE: the scheduler, the words a shell attached, and the three ways it is
//! driven: a shell's request, a commit that reaches the alert index, and a launch.

use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::CommandStatus;

use super::desired::Words;
use super::outbox::{self, MemoryLedger, Ran, Runner};
use super::scheduler::{Scheduler, watches};
use crate::error::Result;
use crate::handle::HandleState;
use crate::screens::ScreenCtx;

pub struct Service {
    pub scheduler: Scheduler,
    words: Arc<dyn Words>,
    ledger: MemoryLedger,
}

impl Service {
    #[must_use]
    pub fn new(words: Arc<dyn Words>) -> Self {
        Self {
            scheduler: Scheduler::new(),
            words,
            ledger: MemoryLedger::default(),
        }
    }
}

struct Commands<'a>(&'a HandleState);

impl Runner for Commands<'_> {
    fn run(
        &self,
        name: &str,
        input: &serde_json::Value,
        key: &str,
    ) -> std::result::Result<Ran, String> {
        match self.0.command(name, input, key) {
            Ok(outcome) if outcome.status == CommandStatus::Executed => Ok(Ran::Done),
            Ok(outcome) => Ok(Ran::Declined(outcome.reason.unwrap_or_default())),
            Err(error) => Err(error.to_string()),
        }
    }
}

impl HandleState {
    /// The set as it should be now, when it moved.
    fn notify_set(&self, service: &Service) -> Result<Option<wire::ScheduleNotifications>> {
        let now = ScreenCtx::now_ms(self).unwrap_or_default();
        self.with_vault(|vault| {
            vault
                .read(|connection| {
                    Ok(service
                        .scheduler
                        .refresh(connection, now, service.words.as_ref()))
                })
                .map_err(Into::into)
        })?
    }

    /// A shell's request: the launch, what the OS did, a batch of presses, the permission ask.
    ///
    /// # Errors
    /// A core with no notification service, or the vault's refusal.
    pub(crate) fn notify_call(
        &self,
        request: &wire::NotifyRequest,
    ) -> Result<wire::NotifyResponse> {
        use wire::notify_request::Kind as K;
        let service = self
            .notify
            .get()
            .ok_or_else(|| crate::error::CoreError::Unsupported {
                type_url: "centraid.core.v1.NotifyRequest".to_owned(),
            })?;
        let mut results = Vec::new();
        match &request.kind {
            Some(K::Launched(launched)) => service.scheduler.launched(launched),
            Some(K::Scheduled(scheduled)) => service.scheduler.scheduled(scheduled),
            Some(K::AskPermission(_)) => service.scheduler.ask_permission(),
            Some(K::Presses(presses)) => {
                let now = ScreenCtx::now_ms(self).unwrap_or_default();
                results = outbox::replay(&presses.items, now, &Commands(self), &service.ledger);
            }
            None => {}
        }
        Ok(wire::NotifyResponse {
            results,
            schedule: self.notify_set(service)?,
        })
    }

    /// A commit wrote `table`: when the alert index may have moved, the set is read again and,
    /// when it differs, pushed to the shell.
    pub(crate) fn notify_changed(&self, table: &str) {
        let Some(service) = self.notify.get() else {
            return;
        };
        if !watches(table) {
            return;
        }
        if let Ok(Some(schedule)) = self.notify_set(service) {
            self.events().push(wire::Event {
                kind: Some(wire::event::Kind::Notify(Box::new(schedule))),
            });
        }
    }

    /// The scheduler, for a producer that offers notices of its own (the backup's).
    #[must_use]
    pub fn notifier(&self) -> Option<&Scheduler> {
        self.notify.get().map(|service| &service.scheduler)
    }

    /// Push the set now (a producer's offer changed it).
    pub fn notify_push(&self) {
        let Some(service) = self.notify.get() else {
            return;
        };
        if let Ok(Some(schedule)) = self.notify_set(service) {
            self.events().push(wire::Event {
                kind: Some(wire::event::Kind::Notify(Box::new(schedule))),
            });
        }
    }
}
