//! The proof screen, `proof.counter`: how many events are upcoming.
//!
//! It exists to prove the runtime end to end with one `load`: a re-render when
//! the table changes, an effect (the clipboard) and a timer (the clipboard
//! clear). It is deleted when the first real screen lands.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;

use crate::screen::{Ctx, Screen};
use crate::strings;

/// The route name.
pub const NAME: &str = "proof.counter";

/// How long a copied count stays on the clipboard.
const CLEAR_AFTER: Duration = Duration::from_secs(30);
const CLEAR_TIMER: &str = "clipboard-clear";

enum Phase {
    Loading,
    Failed,
    Ready(u64),
}

/// The route that opens this screen.
#[must_use]
pub fn route() -> wire::Route {
    wire::Route {
        screen: NAME.to_owned(),
        args: Some(wire::route::Args::Counter(wire::CounterRoute {})),
    }
}

/// The registry factory.
#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    build_with(CLEAR_AFTER)(route)
}

/// A factory whose clipboard clears after `clear_after`; tests shorten it.
pub fn build_with(
    clear_after: Duration,
) -> impl Fn(&wire::Route) -> Option<Box<dyn Screen>> + Send + Sync + 'static {
    move |_| {
        Some(Box::new(Counter {
            phase: Phase::Loading,
            copied: None,
            clear_after,
        }))
    }
}

struct Counter {
    phase: Phase,
    /// The text this screen put on the clipboard, until it is cleared.
    copied: Option<String>,
    clear_after: Duration,
}

impl Counter {
    fn reload(&mut self, ctx: &Ctx) {
        let request = wire::LoadRequest {
            app: "agenda".to_owned(),
            query: "upcoming".to_owned(),
            ..wire::LoadRequest::default()
        };
        self.phase = match ctx.load(request) {
            Ok(loaded) => match loaded.answer.and_then(|answer| answer.answer) {
                Some(wire::app_query_response::Answer::AgendaUpcoming(upcoming)) => {
                    Phase::Ready(upcoming.events.len() as u64)
                }
                _ => Phase::Failed,
            },
            Err(_) => Phase::Failed,
        };
    }
}

impl Screen for Counter {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
                Vec::new()
            }
            Some(E::Counter(counter)) => match counter.kind {
                Some(wire::counter_event::Kind::RetryTapped(_)) => {
                    self.reload(ctx);
                    Vec::new()
                }
                Some(wire::counter_event::Kind::CopyTapped(_)) => {
                    let Phase::Ready(count) = self.phase else {
                        return Vec::new();
                    };
                    let text = count.to_string();
                    self.copied = Some(text.clone());
                    ctx.start_timer(CLEAR_TIMER, self.clear_after);
                    vec![
                        wire::Effect {
                            kind: Some(wire::effect::Kind::ClipboardSet(wire::ClipboardSet {
                                text,
                                sensitive: false,
                            })),
                        },
                        wire::Effect {
                            kind: Some(wire::effect::Kind::Haptic(wire::Haptic {
                                kind: wire::HapticKind::Success as i32,
                            })),
                        },
                    ]
                }
                None => Vec::new(),
            },
            Some(E::TimerFired(fired)) if fired.timer == CLEAR_TIMER => {
                let Some(expected_text) = self.copied.take() else {
                    return Vec::new();
                };
                vec![wire::Effect {
                    kind: Some(wire::effect::Kind::ClipboardClear(wire::ClipboardClear {
                        expected_text,
                    })),
                }]
            }
            // A failed copy leaves nothing to clear.
            Some(E::EffectResult(result)) => {
                if matches!(
                    result.outcome,
                    Some(wire::effect_result::Outcome::Failed(_))
                ) {
                    self.copied = None;
                    ctx.cancel_timer(CLEAR_TIMER);
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Loading => wire::counter_view::Content::Loading(wire::CounterLoading {
                label: strings::counter_loading(locale),
            }),
            Phase::Failed => wire::counter_view::Content::Failed(wire::Failure {
                sentence: strings::counter_failed(locale),
                remedy: strings::counter_retry(locale),
            }),
            Phase::Ready(count) => wire::counter_view::Content::Data(wire::CounterData {
                count_label: strings::counter_count(locale, *count),
                copy_label: strings::counter_copy(locale),
                notice: if self.copied.is_some() {
                    strings::counter_copied(locale)
                } else {
                    String::new()
                },
            }),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Counter(wire::CounterView {
                title: strings::counter_title(locale),
                content: Some(content),
            })),
            ..wire::ViewState::default()
        }
    }
}
