//! A VAULT ON ITS OWN KEY, FILED IN THE MAIN VAULT'S LOCKER (`custody.filing`,
//! a service; R-ONBOARD-10).
//!
//! A vault kept on its own recovery key is otherwise reached only by that key,
//! and a second key to keep safe is one more a member loses. Filed as a Locker
//! note in a vault on the member's own key, it comes back whenever that vault
//! does: the one place inside a vault a recovery key belongs, because the key
//! that opens that Locker is a different one.
//!
//! **It waits for an unlock.** The core seals a Locker secret only while that
//! vault's Locker session is open, and making a vault never opens one, nor
//! should it: the session is the member's presence, proved by the phone's owner
//! check. So the make records the key as pending
//! ([`VaultSecrets::add_pending_filing`]) and this service files each pending key
//! when the runtime relays the Locker's `locker.unlocked` announcement
//! ([`wire::Announced`]). It files into the vault in front only when that vault
//! is on the member's own key, and clears what the core took.
//!
//! The item's invoke key names the item, never the content: an invoke key is
//! logged.

use centraid_api_proto::core_v1 as wire;
use rand::RngCore;
use wire::screen_event::Kind as E;

use super::enrollment::{Env, Job, Out, Progress, Runner};
use super::keeper::{Absent, Keeper, KeeperSlot};
use super::secrets::VaultSecrets;
use crate::catalog::act;
use crate::kit::act as kit_act;
use crate::screen::{Ctx, Screen};
use crate::strings::{custody as words, fill};

/// The topic Locker's wall announces after the core opened its session.
pub const UNLOCKED: &str = "locker.unlocked";

#[must_use]
pub fn build(
    secrets: &VaultSecrets,
    keeper: &KeeperSlot,
    _route: &wire::Route,
) -> Option<Box<dyn Screen>> {
    Some(Box::new(Filing {
        secrets: secrets.clone(),
        keeper: keeper.clone(),
        runner: Runner::default(),
        reading: false,
    }))
}

struct Filing {
    secrets: VaultSecrets,
    keeper: KeeperSlot,
    runner: Runner,
    /// The stores are being read before filing.
    reading: bool,
}

/// An item id: 32 hex digits of the system's CSPRNG.
fn item_id() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl Filing {
    fn run(&mut self, event: Run, ctx: &Ctx) -> Vec<wire::Effect> {
        let keeper = self.keeper.get();
        let absent = Absent;
        let keeper: &dyn Keeper = keeper.as_deref().unwrap_or(&absent);
        let env = Env {
            ctx,
            secrets: &self.secrets,
            keeper,
        };
        let progress = match event {
            Run::Begin => self.runner.begin(Job::reload(), &env),
            Run::Answer(result) => match self.runner.answered(&result, &env) {
                Some(progress) => progress,
                None => return Vec::new(),
            },
        };
        let Progress { mut effects, out } = progress;
        if matches!(out, Some(Out::Done)) && self.reading {
            self.reading = false;
            let ops = self.file(&env);
            if !ops.is_empty() {
                effects.extend(self.runner.begin(Job::write(ops), &env).effects);
            }
        }
        effects
    }

    /// File every pending key into the vault in front, if it is a main vault;
    /// the secret writes that clear what the core took.
    fn file(&self, env: &Env) -> Vec<wire::SecretOp> {
        let pending = self.secrets.pending_filings();
        if pending.is_empty() {
            return Vec::new();
        }
        let Some(front) = env.keeper.foreground() else {
            return Vec::new();
        };
        // A VAULT ON ITS OWN KEY is no main vault: its Locker needs its own key
        // to reach, so a key filed there is lost with it.
        if self.secrets.own_seed_of(&front.vault_id).is_some()
            || self.secrets.vault_index(&front.vault_id).is_none()
        {
            return Vec::new();
        }
        let mut cleared = Vec::new();
        for (own, name) in pending {
            let Some(key_words) = self.secrets.own_words(&own) else {
                // NOTHING HERE TO FILE (the words were never kept on this
                // phone): the entry is dropped rather than retried forever.
                cleared.push(own);
                continue;
            };
            if file_note(env.ctx, &name, &key_words) {
                cleared.push(own);
            }
        }
        if cleared.is_empty() {
            Vec::new()
        } else {
            self.secrets.clear_pending_filings(&cleared)
        }
    }
}

enum Run {
    Begin,
    Answer(wire::EffectResult),
}

/// One `locker.add_item` note; true only when the core executed it.
fn file_note(ctx: &Ctx, name: &str, key_words: &[String]) -> bool {
    let id = item_id();
    let request = act::locker::AddItem {
        title: fill(&words::own_key_filed_title(ctx.locale()), &[("name", name)]),
        r#type: act::locker::AddItemType::Note,
        item_id: Some(id.clone()),
        content: Some(key_words.join(" ")),
        ..act::locker::AddItem::default()
    };
    kit_act::act(ctx, request, &format!("locker.add_item:{id}")).committed
}

impl Screen for Filing {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Announced(note)) if note.topic == UNLOCKED && !self.runner.busy() => {
                self.reading = true;
                self.run(Run::Begin, ctx)
            }
            Some(E::EffectResult(result)) => self.run(Run::Answer(result), ctx),
            _ => Vec::new(),
        }
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState::default()
    }
}
