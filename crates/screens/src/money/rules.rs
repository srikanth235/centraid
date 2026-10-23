use centraid_api_proto::core_v1 as wire;

use crate::screen::Screen;

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    None
}
