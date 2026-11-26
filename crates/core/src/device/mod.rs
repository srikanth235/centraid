//! THE DEVICE STORE (app-plane §10, D1–D12): what the core keeps outside the vault, and the
//! registry that lists every key a shell or the core writes.

/// The setting the notification service reads: details on the lock screen, `"on"` or `"off"`.
pub const DETAILS_KEY: &str = "settings.details";

pub mod draft;
pub mod inbox;
pub mod open_url;
pub mod registry;
pub mod store;

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
