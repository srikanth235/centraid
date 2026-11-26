//! `load(app, query, params)`: THE ONE READ (#1135).
//!
//! A shell, the chat and the training harness name an app's query and state its
//! arguments by name. This module is the core's half of `action.proto`'s
//! `LoadRequest`:
//!
//! 1. the app's manifest must DECLARE the query — the catalogue is the manifest,
//!    so a name it does not list is refused whatever the core could run;
//! 2. [`read`] decodes `params` into the query's typed request, in Rust, and
//!    refuses a parameter the query does not take and one of the wrong type;
//! 3. it then calls the app's own reader (`app_query::<app>::<reader>`) directly
//!    and answers that reader's typed answer, with the tables the door read.
//!
//! THE MANIFEST NAME IS THE ONLY NAME. The readers are keyed by the names the
//! manifests declare (`people.people`, not the arm it runs); the
//! `AppQueryRequest` oneof a screen still sends is not on this path. The test
//! `every_manifest_query_has_a_reader_and_no_reader_lacks_a_manifest_query`
//! holds the two lists to each other, so a manifest that grows a query before the
//! core can read it fails there and, at run time, is refused with that sentence
//! instead of answering nothing.

use std::collections::BTreeSet;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::Vault;

use crate::app_query::{self, VaultDoor};
use crate::catalog;
use crate::error::{CoreError, Result};

/// Run one query against the open vault.
///
/// # Errors
/// [`CoreError::InvalidRequest`] for an app or query the catalogue lacks, a
/// parameter the query does not take, or one of the wrong type; whatever the
/// query itself refuses with.
pub fn load(vault: &Vault, request: &wire::LoadRequest) -> Result<wire::LoadResponse> {
    let manifest = catalog::manifest_of(&request.app).ok_or_else(|| CoreError::InvalidRequest {
        detail: format!("`{}` is not an app this core carries", request.app),
    })?;
    if manifest.query(&request.query).is_none() {
        return Err(CoreError::InvalidRequest {
            detail: format!(
                "app `{}` declares no query `{}`",
                request.app, request.query
            ),
        });
    }
    let mut params = Params::new(request);
    let now = vault.clock().now_text();
    let door = VaultDoor::new(vault);
    let Some(answer) = read(
        vault,
        &door,
        &now,
        &request.app,
        &request.query,
        &mut params,
    )?
    else {
        return Err(CoreError::InvalidRequest {
            detail: format!(
                "app `{}` declares the query `{}` and this core has no reader for it yet",
                request.app, request.query
            ),
        });
    };
    params.finish()?;
    let tables: BTreeSet<String> = door.take_tables();
    Ok(wire::LoadResponse {
        answer: Some(wire::AppQueryResponse {
            answer: Some(answer),
        }),
        tables: tables.into_iter().collect(),
    })
}

/// The reader of a query's arguments. Every read marks the name consumed;
/// [`Params::finish`] refuses any name nothing read.
pub(crate) struct Params<'a> {
    request: &'a wire::LoadRequest,
    pub(crate) read: BTreeSet<&'a str>,
    /// `limit` and `after` ride the request itself, so they are marked here
    /// only when a query takes them.
    pub(crate) limit_taken: bool,
    pub(crate) after_taken: bool,
}

impl<'a> Params<'a> {
    pub(crate) fn new(request: &'a wire::LoadRequest) -> Self {
        Self {
            request,
            read: BTreeSet::new(),
            limit_taken: false,
            after_taken: false,
        }
    }

    fn bad(&self, name: &str, wanted: &str) -> CoreError {
        CoreError::InvalidRequest {
            detail: format!(
                "`{}.{}` takes `{name}` as {wanted}",
                self.request.app, self.request.query
            ),
        }
    }

    fn value(&mut self, name: &'a str) -> Option<&'a wire::Value> {
        self.read.insert(name);
        self.request
            .params
            .get(name)
            .filter(|value| !matches!(value.kind, Some(wire::value::Kind::Null(_)) | None))
    }

    /// The zone the answer's civil readings are drawn in.
    pub(crate) fn zone(&self) -> String {
        self.request.zone.clone()
    }

    /// The request's `limit`, or `default` when it states none.
    pub(crate) fn limit(&mut self, default: u32) -> u32 {
        self.limit_taken = true;
        if self.request.limit == 0 {
            default
        } else {
            self.request.limit
        }
    }

    /// The request's `after` as it was sent, for a query whose cursor is one number.
    pub(crate) fn after_raw(&mut self) -> String {
        self.after_taken = true;
        self.request.after.clone()
    }

    /// A string; absent is empty, as proto3 reads it.
    pub(crate) fn text(&mut self, name: &'a str) -> Result<String> {
        Ok(self.opt_text(name)?.unwrap_or_default())
    }

    pub(crate) fn opt_text(&mut self, name: &'a str) -> Result<Option<String>> {
        match self.value(name).map(|value| &value.kind) {
            None => Ok(None),
            Some(Some(wire::value::Kind::Text(text))) => Ok(Some(text.clone())),
            Some(_) => Err(self.bad(name, "text")),
        }
    }

    fn integer(&mut self, name: &'a str) -> Result<Option<i64>> {
        match self.value(name).map(|value| &value.kind) {
            None => Ok(None),
            Some(Some(wire::value::Kind::Integer(number))) => Ok(Some(*number)),
            Some(_) => Err(self.bad(name, "an integer")),
        }
    }

    pub(crate) fn opt_int(&mut self, name: &'a str) -> Result<Option<i64>> {
        self.integer(name)
    }

    /// Refuse any argument no reader asked for.
    pub(crate) fn finish(&self) -> Result<()> {
        if let Some(unknown) = self
            .request
            .params
            .keys()
            .find(|name| !self.read.contains(name.as_str()))
        {
            return Err(CoreError::InvalidRequest {
                detail: format!(
                    "`{}.{}` takes no `{unknown}`",
                    self.request.app, self.request.query
                ),
            });
        }
        if self.request.limit != 0 && !self.limit_taken {
            return Err(CoreError::InvalidRequest {
                detail: format!(
                    "`{}.{}` takes no `limit`",
                    self.request.app, self.request.query
                ),
            });
        }
        if !self.request.after.is_empty() && !self.after_taken {
            return Err(CoreError::InvalidRequest {
                detail: format!(
                    "`{}.{}` takes no `after`",
                    self.request.app, self.request.query
                ),
            });
        }
        Ok(())
    }
}

#[allow(clippy::too_many_lines)]
fn read(
    vault: &Vault,
    door: &VaultDoor<'_>,
    _now: &str,
    app: &str,
    query: &str,
    p: &mut Params<'_>,
) -> Result<Option<wire::app_query_response::Answer>> {
    let tz = p.zone();
    let answer = match (app, query) {
        ("shell", "files-followed") => app_query::imports::files_followed(door)?,
        // reconnect (#1185): the phone stores the vault was following, on whichever phone
        ("shell", "followed-stores") => app_query::imports::followed_stores(door)?,
        // following (#1183): what the phone says that differs from one followed row
        ("shell", "phone-differences") => {
            app_query::follow::differences(vault, &p.text("entity_id")?)?
        }
        // history (#1185): a page of one record's earlier versions, and how many it holds
        ("shell", "earlier-versions") => {
            let after = p.after_raw();
            let limit = p.limit(app_query::history::PAGE as u32);
            app_query::history::versions(vault, &p.text("entity_id")?, &tz, &after, limit as usize)?
        }
        ("shell", "earlier-record") => app_query::history::record(
            vault,
            &p.text("entity_id")?,
            p.opt_int("seq")?.unwrap_or_default(),
            &tz,
        )?,
        // following (#1183): where the last read of a phone store got to, for this install
        ("shell", "origin-cursor") => app_query::follow::origin_cursor(
            vault,
            &p.text("system")?,
            &p.text("ref")?,
            &p.text("device_id")?,
        )?,
        // arrival (#1185): where one record came from, a followed store or a one-shot arrival
        ("shell", "earlier-count") => app_query::history::count(vault, &p.text("entity_id")?)?,
        // the general link (#1185): what an item is linked to, and the picker's rows
        ("shell", "chats") => app_query::chat::threads(
            vault,
            door,
            &wire::ChatThreadsRequest {
                limit: p.limit(0),
                term: p.text("term")?,
            },
        )?,
        ("shell", "chat") => app_query::chat::thread(
            vault,
            &wire::ChatThreadRequest {
                thread_id: p.text("thread_id")?,
            },
        )?,
        ("shell", "chat-card") => app_query::chat::card(
            vault,
            &wire::ChatCardRequest {
                app: p.text("app")?,
                entity: p.text("entity")?,
                id: p.text("id")?,
            },
        )?,

        _ => return Ok(None),
    };
    Ok(Some(answer))
}
