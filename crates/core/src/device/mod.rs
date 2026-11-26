//! THE DEVICE STORE (app-plane §10, D1–D12): what the core keeps outside the vault, and the
//! registry that lists every key a shell or the core writes.

/// The setting the notification service reads: details on the lock screen, `"on"` or `"off"`.
pub const DETAILS_KEY: &str = "settings.details";

pub mod draft;
pub mod inbox;
pub mod open_url;
pub mod registry;
pub mod store;
pub mod widget;

pub use draft::{Draft, DraftError, Drafts};
pub use registry::{DEVICE_KEYS, KeyDecl, KeyError, Owner, Place, Shape};
pub use store::{Checked, DeviceStore, DirStore, MemoryStore};

use centraid_api_proto::core_v1 as wire;

impl crate::handle::HandleState {
    /// A shell's read or write of one device key, through the registry.
    pub(crate) fn device_call(
        &self,
        request: &wire::DeviceRequest,
    ) -> crate::error::Result<wire::DeviceResponse> {
        use wire::device_request::Kind as K;
        let store = self.device()?;
        let refused = |detail: String| crate::error::CoreError::InvalidRequest { detail };
        match &request.kind {
            Some(K::Get(get)) => {
                let value = store.get(&get.key).map_err(refused)?;
                Ok(wire::DeviceResponse {
                    found: value.is_some(),
                    value: value.unwrap_or_default(),
                })
            }
            Some(K::Put(put)) => {
                store.put(&put.key, &put.value).map_err(refused)?;
                if put.key == DETAILS_KEY {
                    self.notify_push();
                }
                Ok(wire::DeviceResponse::default())
            }
            Some(K::Delete(delete)) => {
                store.delete(&delete.key).map_err(refused)?;
                Ok(wire::DeviceResponse::default())
            }
            None => Err(refused(
                "a device request names get, put or delete".to_owned(),
            )),
        }
    }
}

const FOLLOW_SYSTEMS: [&str; 8] = [
    "contacts",
    "calendar",
    "files",
    "camera_roll",
    "reminders",
    "health",
    "health_readings",
    "statement",
];

impl crate::handle::HandleState {
    /// A shell's follow pass, or its stop of one.
    pub(crate) fn follow_call(
        &self,
        request: &wire::FollowRequest,
    ) -> crate::error::Result<wire::FollowResponse> {
        let refused = |detail: String| crate::error::CoreError::InvalidRequest { detail };
        if !FOLLOW_SYSTEMS.contains(&request.system.as_str()) {
            return Err(refused(format!(
                "`{}` is not a followed store",
                request.system
            )));
        }
        let name = match wire::FollowVerb::try_from(request.verb) {
            Ok(wire::FollowVerb::Pass) => format!("follow.{}", request.system),
            Ok(wire::FollowVerb::Stop) => "follow.stop".to_owned(),
            _ => return Err(refused("a follow request names pass or stop".to_owned())),
        };
        let input: serde_json::Value = serde_json::from_str(&request.input_json)
            .map_err(|error| refused(format!("the snapshot is not JSON: {error}")))?;
        let outcome = self.command(&name, &input, &request.invoke_key)?;
        let declined = outcome.status != centraid_vault::CommandStatus::Executed;
        Ok(wire::FollowResponse {
            output_json: outcome.output.to_string(),
            declined,
            sentence: outcome.reason.unwrap_or_default(),
        })
    }

    /// A shell's drain of the share-in inbox.
    pub(crate) fn share_in_call(
        &self,
        request: &wire::ShareInRequest,
    ) -> crate::error::Result<wire::ShareInResponse> {
        use inbox::{Fate, Route};
        if request.inbox_dir.is_empty() {
            return Err(crate::error::CoreError::InvalidRequest {
                detail: "the share-in drain names the inbox".to_owned(),
            });
        }
        let handle = crate::handle::Handle::of(self).ok_or(crate::error::CoreError::Closed)?;
        let report = inbox::drain(
            std::path::Path::new(&request.inbox_dir),
            &inbox::CoreFiler(&handle),
        );
        Ok(wire::ShareInResponse {
            items: report
                .items
                .into_iter()
                .map(|(uuid, fate)| {
                    let (fate, detail) = match fate {
                        Fate::Filed(route) => (
                            wire::ShareInFate::Filed,
                            match route {
                                Route::Note => "note",
                                Route::Photo => "photo",
                                Route::Document => "document",
                                Route::Vcard | Route::CsvPeople => "people",
                                Route::Later(_) => "",
                            }
                            .to_owned(),
                        ),
                        Fate::Already => (wire::ShareInFate::Already, String::new()),
                        Fate::Kept(why) => (wire::ShareInFate::Kept, why),
                    };
                    wire::ShareInItem {
                        uuid,
                        fate: fate as i32,
                        detail,
                    }
                })
                .collect(),
        })
    }
}
