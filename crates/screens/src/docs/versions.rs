//! A DOCUMENT'S VERSION HISTORY (`docs.versions`): a screen over `docs.history`
//! and `restore-version`.
//!
//! A version is the bytes a replace or an edit put down, numbered from the oldest
//! (A→B→A is three versions: each is an occurrence, dated by when it became
//! current). An earlier version of a LIVE document can be made current again —
//! the restore keeps what it replaced as a version of its own; a trashed one is
//! restored first (the vault refuses otherwise), so its rows offer nothing.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::docs_versions_event::Kind as V;
use wire::screen_event::Kind as E;

use super::{Phase, denied, fold, refusal};
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::read;
use crate::screen::{Ctx, Screen};
use crate::strings::docs as words;

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::DocsVersions(args)) = &route.args else {
        return None;
    };
    if args.document_id.is_empty() {
        return None;
    }
    Some(Box::new(Versions {
        document_id: args.document_id.clone(),
        title: args.title.clone(),
        phase: Phase::Loading,
        status: None,
    }))
}

struct Versions {
    document_id: String,
    /// The document's title: this page's back word.
    title: String,
    phase: Phase<wire::DocsDocument>,
    status: Option<wire::StatusLine>,
}

impl Versions {
    fn reload(&mut self, ctx: &Ctx) {
        self.phase = Phase::of(read::read(
            ctx,
            load::docs::History {
                document_id: self.document_id.clone(),
            },
            |answer| match answer {
                Answer::DocsDocument(document) => Some(document),
                _ => None,
            },
        ));
    }

    /// The version `key` names, when it can be made current.
    fn restorable(&self, key: &str) -> Option<i64> {
        let document = self.phase.data()?;
        let trashed = document.document.as_ref()?.trashed;
        let version = document
            .versions
            .iter()
            .find(|version| version.number.to_string() == key)?;
        (!version.current && !trashed).then_some(i64::from(version.number))
    }

    fn restore(&mut self, ctx: &Ctx, key: &str) {
        let Some(seq) = self.restorable(key) else {
            return;
        };
        self.status = None;
        let request: wire::ActRequest = act::docs::RestoreVersion {
            document_id: self.document_id.clone(),
            seq,
        }
        .into();
        let key = kit_act::key(&[&request.action, &self.document_id, key], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        if !settled.committed {
            self.status = Some(refusal(settled.refusal));
        }
        self.reload(ctx);
    }
}

impl Screen for Versions {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
            }
            Some(E::DocsVersions(event)) => match event.kind {
                Some(V::Refreshed(_)) => self.reload(ctx),
                Some(V::Restored(restored)) => self.restore(ctx, &restored.key),
                None => {}
            },
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::docs_versions_state::Content;
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Loading => Content::Loading(wire::Loading { first_load: true }),
            Phase::Failed => Content::Failure(read::failure(locale)),
            Phase::Denied(denial) => Content::Denied(denied(locale, denial)),
            Phase::Ready(document) => {
                let trashed = document.document.as_ref().is_some_and(|row| row.trashed);
                Content::Data(wire::DocsVersionsData {
                    versions: document
                        .versions
                        .iter()
                        .map(|version| fold::version(locale, version, trashed))
                        .collect(),
                    empty: (document.document.is_none() || document.versions.is_empty()).then(
                        || wire::EmptyState {
                            headline: words::gone(locale),
                            ..wire::EmptyState::default()
                        },
                    ),
                })
            }
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::DocsVersions(
                wire::DocsVersionsState {
                    document_id: self.document_id.clone(),
                    title: self.title.clone(),
                    content: Some(content),
                    status: self.status.clone(),
                    chrome: Some(wire::DocsVersionsChrome {
                        back: if self.title.trim().is_empty() {
                            words::app_title(locale)
                        } else {
                            self.title.clone()
                        },
                        heading: words::versions_heading(locale),
                        retry: words::retry(locale),
                        loading: words::loading(locale),
                    }),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
