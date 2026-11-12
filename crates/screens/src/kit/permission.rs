//! THE ONE PERMISSION VOICE (#1185). Every phone grant Centraid asks for (the camera roll, the
//! calendar, contacts, reminders, Health, notifications, the camera, files) says the same four things
//! the same way, and Rust says them: a shell reports the STATE the platform is in and words nothing.
//!
//! | State | Means | Says | Points to Settings |
//! |---|---|---|---|
//! | [`State::NotAsked`] | the phone was never asked | what Centraid needs it for | no (the ask is the button) |
//! | [`State::Refused`] | the member said no | it is off | yes |
//! | [`State::Restricted`] | a policy (parental controls, a managed phone) blocks it | the phone does not allow it | NO: no button here can change it |
//! | [`State::Limited`] | a grant that is not enough (some photos, write-only calendar) | what that costs here | where it is a remedy |
//!
//! A platform that cannot produce a state never sends it: [`Resource::receives`] names the states each
//! resource can be in, and the test of this module holds every one of them to a sentence of its own.
//! A refused grant on an [`wire::EffectFailed`] is `denied`, `restricted` or `limited`
//! ([`State::of`]); the camera roll's and notifications' own answers carry the same states
//! ([`State::of_photos`], [`State::of_notifications`]).

use centraid_api_proto::core_v1 as wire;

use crate::strings::{Locale, fill, permission as words};

/// What a phone grant is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resource {
    Photos,
    Calendar,
    Contacts,
    Reminders,
    Health,
    Notifications,
    Camera,
    Files,
}

/// Where a grant stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    NotAsked,
    Refused,
    Restricted,
    Limited,
}

impl State {
    /// The state a refused effect names, or `None` for a failure that is not a grant's.
    #[must_use]
    pub fn of(failed: &wire::EffectFailed) -> Option<Self> {
        if failed.restricted {
            Some(Self::Restricted)
        } else if failed.limited {
            Some(Self::Limited)
        } else if failed.denied {
            Some(Self::Refused)
        } else {
            None
        }
    }

    /// The state the camera roll's grant is in, or `None` while it is granted (or unsaid).
    #[must_use]
    pub fn of_photos(permission: wire::PhotosMediaPermission) -> Option<Self> {
        use wire::PhotosMediaPermission as P;
        match permission {
            P::NotAsked => Some(Self::NotAsked),
            P::Denied => Some(Self::Refused),
            P::Restricted => Some(Self::Restricted),
            P::Limited => Some(Self::Limited),
            P::Granted | P::Unspecified => None,
        }
    }

    /// The state notifications are in, or `None` while they are allowed (or unsaid).
    #[must_use]
    pub fn of_notifications(permission: wire::NotificationPermission) -> Option<Self> {
        use wire::NotificationPermission as P;
        match permission {
            P::NotAsked => Some(Self::NotAsked),
            P::Denied => Some(Self::Refused),
            P::Granted | P::Unspecified => None,
        }
    }
}

impl Resource {
    /// Every resource.
    pub const ALL: [Self; 8] = [
        Self::Photos,
        Self::Calendar,
        Self::Contacts,
        Self::Reminders,
        Self::Health,
        Self::Notifications,
        Self::Camera,
        Self::Files,
    ];

    /// The states a platform can put this resource in. A state not listed is never sent.
    #[must_use]
    pub const fn receives(self) -> &'static [State] {
        use State::{Limited, NotAsked, Refused, Restricted};
        match self {
            // Photos and Contacts: a limited selection. Calendar and Reminders: iOS 17's write-only
            // access, which is not enough to read.
            Self::Photos | Self::Contacts | Self::Calendar | Self::Reminders => {
                &[NotAsked, Refused, Restricted, Limited]
            }
            Self::Health | Self::Camera => &[NotAsked, Refused, Restricted],
            Self::Notifications => &[NotAsked, Refused],
            // The file picker asks nothing of the member before it opens.
            Self::Files => &[Refused],
        }
    }
}

/// THE SENTENCE for a resource in a state. A state a resource cannot receive reads as a refusal, so
/// nothing is ever said wrongly or not at all.
#[must_use]
pub fn says(locale: Locale, resource: Resource, state: State) -> String {
    use Resource as R;
    use State as S;
    match (resource, state) {
        (R::Photos, S::NotAsked) => words::photos_not_asked(locale),
        (R::Photos, S::Refused) => words::photos_refused(locale),
        (R::Photos, S::Restricted) => words::photos_restricted(locale),
        (R::Photos, S::Limited) => words::photos_limited(locale),
        (R::Calendar, S::NotAsked) => words::calendar_not_asked(locale),
        (R::Calendar, S::Refused) => words::calendar_refused(locale),
        (R::Calendar, S::Restricted) => words::calendar_restricted(locale),
        (R::Calendar, S::Limited) => words::calendar_limited(locale),
        (R::Contacts, S::NotAsked) => words::contacts_not_asked(locale),
        (R::Contacts, S::Refused) => words::contacts_refused(locale),
        (R::Contacts, S::Restricted) => words::contacts_restricted(locale),
        (R::Contacts, S::Limited) => words::contacts_limited(locale),
        (R::Reminders, S::NotAsked) => words::reminders_not_asked(locale),
        (R::Reminders, S::Refused) => words::reminders_refused(locale),
        (R::Reminders, S::Restricted) => words::reminders_restricted(locale),
        (R::Reminders, S::Limited) => words::reminders_limited(locale),
        (R::Health, S::NotAsked) => words::health_not_asked(locale),
        (R::Health, S::Refused | S::Limited) => words::health_refused(locale),
        (R::Health, S::Restricted) => words::health_restricted(locale),
        (R::Notifications, S::NotAsked) => words::notifications_not_asked(locale),
        (R::Notifications, S::Refused | S::Limited) => words::notifications_refused(locale),
        (R::Notifications, S::Restricted) => words::notifications_restricted(locale),
        (R::Camera, S::NotAsked) => words::camera_not_asked(locale),
        (R::Camera, S::Refused | S::Limited) => words::camera_refused(locale),
        (R::Camera, S::Restricted) => words::camera_restricted(locale),
        (R::Files, S::NotAsked) => words::files_not_asked(locale),
        (R::Files, S::Refused | S::Limited) => words::files_refused(locale),
        (R::Files, S::Restricted) => words::files_restricted(locale),
    }
}

/// WHAT THE PHONE SAYS ABOUT ALERTS (#1188, NA1), as the one notification service last heard it.
/// Everything that asks for or relies on notifications (a reminder's or an event's editor, the
/// Backup screen's stale-backup line) reads the same facts and says the same sentence.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AlertFacts {
    /// `None` while the phone has not answered yet.
    pub permission: Option<wire::NotificationPermission>,
    /// Android: exact alarms are not allowed, so an alert can be minutes late.
    pub exact_denied: bool,
    /// Android: the channel is switched off; `channel` is its name as the system shows it.
    pub channel_off: bool,
    pub channel: String,
    /// The same for the backup channel.
    pub backup_channel_off: bool,
    pub backup_channel: String,
}

impl AlertFacts {
    /// What a `NotificationsScheduled` answer says.
    #[must_use]
    pub fn of(scheduled: &wire::NotificationsScheduled) -> Self {
        Self {
            permission: wire::NotificationPermission::try_from(scheduled.permission).ok(),
            exact_denied: scheduled.exact_denied,
            channel_off: scheduled.channel_off,
            channel: scheduled.channel_shown.clone(),
            backup_channel_off: scheduled.backup_channel_off,
            backup_channel: scheduled.backup_channel_shown.clone(),
        }
    }

    /// The one line to show, or `None` when alerts will arrive on time. A refused or never-asked
    /// grant says its own sentence; a granted one that the phone still limits says which limit.
    #[must_use]
    pub fn line(&self, locale: Locale) -> Option<String> {
        self.line_for(locale, Channel::Reminders)
    }

    /// The same for the notices of one `channel`.
    #[must_use]
    pub fn line_for(&self, locale: Locale, channel: Channel) -> Option<String> {
        if let Some(state) = self.permission.and_then(State::of_notifications) {
            return Some(says(locale, Resource::Notifications, state));
        }
        if channel == Channel::Reminders && self.channel_off {
            return Some(words::notifications_reminders_off(locale));
        }
        if channel == Channel::Backup && self.backup_channel_off {
            let shown = if self.backup_channel.is_empty() {
                words::notifications_backup_channel_fallback(locale)
            } else {
                self.backup_channel.clone()
            };
            return Some(fill(
                &words::notifications_channel_off(locale),
                &[("channel", &shown)],
            ));
        }
        self.exact_denied
            .then(|| words::notifications_inexact(locale))
    }
}

/// The phone-store key of the "show details" choice (#1188, NA3): "off" hides what a reminder or an
/// event notification says; anything else, or nothing stored, shows it.
const DETAILS_KEY: &str = "alert_details";

/// Whether notifications show their details: on unless the member turned it off.
#[must_use]
pub fn details_shown(secrets: &crate::custody::secrets::VaultSecrets) -> bool {
    secrets.device_value(DETAILS_KEY).as_deref() != Some("off")
}

/// The op that keeps the choice.
#[must_use]
pub fn details_op(shown: bool) -> wire::SecretOp {
    crate::custody::secrets::VaultSecrets::device_set(DETAILS_KEY, if shown { "" } else { "off" })
}

/// Which of the app's notification channels a notice posts to (Android shows a channel's name in
/// system settings; iOS has none). The backup warnings have a channel of their own, so switching
/// off reminders does not silence them, and the reverse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Reminders,
    Backup,
}

impl Channel {
    /// The id the wire names it by (`PendingNotification.channel_id`); empty is Reminders.
    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            Self::Reminders => "",
            Self::Backup => "backup",
        }
    }
}

impl Channel {
    /// The thread its notices are grouped under.
    #[must_use]
    pub const fn thread(self) -> &'static str {
        match self {
            Self::Reminders => "reminders",
            Self::Backup => "backup",
        }
    }
}

/// A notice a screen other than Agenda wants held, posted through the one notification service
/// (#1188): a fixed instant, no buttons, a tap that opens `opens`.
#[derive(Clone, Debug, PartialEq)]
pub struct ExtraNotice {
    /// Deterministic: the same notice has the same id, so the shell replaces rather than doubles it.
    pub id: String,
    pub channel: Channel,
    pub fire_at_ms: i64,
    pub title: String,
    pub body: String,
    pub opens: wire::Route,
}

/// What one producer wants held, and which of its delivered notices are still wanted.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Offer {
    pub notices: Vec<ExtraNotice>,
    pub wanted: Vec<String>,
}

#[derive(Debug, Default)]
struct Inner {
    facts: AlertFacts,
    offers: std::collections::BTreeMap<String, Offer>,
    /// A screen asked for the system prompt (Backup's "Allow notifications"); the next sync asks.
    asking: bool,
}

/// THE ONE BOARD the notification service and every screen that relies on alerts share, so a
/// refusal is said in the same words wherever an alert is set, and a second producer posts through
/// the one service (#1188, NA1/NB2).
#[derive(Clone, Debug, Default)]
pub struct AlertBoard(std::sync::Arc<std::sync::Mutex<Inner>>);

impl AlertBoard {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// What the phone last said.
    #[must_use]
    pub fn get(&self) -> AlertFacts {
        self.lock().facts.clone()
    }

    /// Record what the phone said; whether it differs from what was known.
    pub fn set(&self, facts: AlertFacts) -> bool {
        let mut held = self.lock();
        let changed = held.facts != facts;
        held.facts = facts;
        changed
    }

    /// A PRODUCER'S WORD: what `producer` wants held and which of its delivered notices are still
    /// wanted (an empty offer withdraws it). The service hears of a change and speaks again.
    pub fn offer(&self, ctx: &crate::screen::Ctx, producer: &str, offer: Offer) {
        if self.hold(producer, offer) {
            Self::signal(ctx);
        }
    }

    /// `offer` for a caller with no `Ctx` (start-up registration, tests): records the offer and
    /// says whether it changed. It posts nothing; send the service a `Signalled`.
    pub fn hold(&self, producer: &str, offer: Offer) -> bool {
        let mut inner = self.lock();
        if offer == Offer::default() {
            inner.offers.remove(producer).is_some()
        } else {
            inner.offers.insert(producer.to_owned(), offer.clone()) != Some(offer)
        }
    }

    fn signal(ctx: &crate::screen::Ctx) {
        ctx.post(
            crate::agenda::notify::NAME,
            wire::ScreenEvent {
                kind: Some(wire::screen_event::Kind::Signalled(wire::Signalled {})),
            },
        );
    }

    /// THE MEMBER SAID "Allow notifications" on a screen that explained why (Backup's sheet): the
    /// service's next sync starts the system prompt, through the same one path as the agenda's. A
    /// producer's notices alone never ask; only this does.
    pub fn ask(&self, ctx: &crate::screen::Ctx) {
        self.request_ask();
        Self::signal(ctx);
    }

    /// `ask` for a caller with no `Ctx`; send the service a `Signalled` after it.
    pub fn request_ask(&self) {
        self.lock().asking = true;
    }

    /// Whether `ask` was called since the service last spoke; clears it.
    pub(crate) fn take_ask(&self) -> bool {
        std::mem::take(&mut self.lock().asking)
    }

    /// Every producer's notices, soonest first, each id once.
    #[must_use]
    pub fn notices(&self) -> Vec<ExtraNotice> {
        let mut all: Vec<ExtraNotice> = self
            .lock()
            .offers
            .values()
            .flat_map(|offer| offer.notices.clone())
            .collect();
        all.sort_by(|a, b| (a.fire_at_ms, &a.id).cmp(&(b.fire_at_ms, &b.id)));
        all.dedup_by(|a, b| a.id == b.id);
        all
    }

    /// The delivered ids the producers still want.
    #[must_use]
    pub fn wanted(&self) -> Vec<String> {
        self.lock()
            .offers
            .values()
            .flat_map(|offer| offer.wanted.clone())
            .collect()
    }
}

/// What a refused effect says for `resource`, or `None` when the failure is not a grant's.
#[must_use]
pub fn refusal(locale: Locale, resource: Resource, failed: &wire::EffectFailed) -> Option<String> {
    State::of(failed).map(|state| says(locale, resource, state))
}

#[cfg(test)]
#[path = "permission/tests.rs"]
mod tests;
