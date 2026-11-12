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
        }
    }

    /// The one line to show, or `None` when alerts will arrive on time. A refused or never-asked
    /// grant says its own sentence; a granted one that the phone still limits says which limit.
    #[must_use]
    pub fn line(&self, locale: Locale) -> Option<String> {
        if let Some(state) = self.permission.and_then(State::of_notifications) {
            return Some(says(locale, Resource::Notifications, state));
        }
        if self.channel_off {
            let channel = if self.channel.is_empty() {
                words::notifications_channel_fallback(locale)
            } else {
                self.channel.clone()
            };
            return Some(fill(
                &words::notifications_channel_off(locale),
                &[("channel", &channel)],
            ));
        }
        self.exact_denied
            .then(|| words::notifications_inexact(locale))
    }
}

/// THE ONE BOARD the notification service writes and every screen that relies on alerts reads, so a
/// refusal is said in the same words wherever an alert is set (#1188, NA1).
#[derive(Clone, Debug, Default)]
pub struct AlertBoard(std::sync::Arc<std::sync::Mutex<AlertFacts>>);

impl AlertBoard {
    fn lock(&self) -> std::sync::MutexGuard<'_, AlertFacts> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// What the phone last said.
    #[must_use]
    pub fn get(&self) -> AlertFacts {
        self.lock().clone()
    }

    /// Record what the phone said; whether it differs from what was known.
    pub fn set(&self, facts: AlertFacts) -> bool {
        let mut held = self.lock();
        let changed = *held != facts;
        *held = facts;
        changed
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
