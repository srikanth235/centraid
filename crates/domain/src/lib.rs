//! THE APP PLANE'S DECLARATIONS.
//!
//! [`KINDS`], [`ACTIONS`] and [`READS`] are the one catalogue the assistant's tool vocabulary,
//! the screens' reads and the registry test are generated from or held to. A kind is one row
//! of promises ([`kind`]); an action wraps one vault command ([`action`]); a read is registered
//! SQL under SQLite's authorizer and a plan gate ([`read`]). The apps' own modules ([`apps`])
//! declare their kinds and reads. [`chat`] is what the model may call a kind and which fields a
//! question can name; the assistant's catalogue is generated from it and from [`ACTIONS`], and
//! [`census`] says how chat reaches each action.
//!
//! The rest is the vault read door the assistant and the search index share: a keyset page, a
//! row, the statement grammar and the money law. `actions`, `grammar`, `manifest`, `reads`,
//! `statement` and `testdoor` are the old plane's door; each leaves with its last caller.

/// The slices joined into one `const` slice, in the order given. `$fill` only gives the array
/// something to hold while it is built.
macro_rules! concat_slices {
    ($ty:ty, $fill:expr; $($slice:expr),+ $(,)?) => {{
        const LEN: usize = 0 $(+ $slice.len())+;
        const OUT: [$ty; LEN] = {
            let mut out = [$fill; LEN];
            let mut at = 0;
            $({
                let part: &[$ty] = $slice;
                let mut each = 0;
                while each < part.len() {
                    out[at] = part[each];
                    at += 1;
                    each += 1;
                }
            })+
            let _ = at;
            out
        };
        &OUT
    }};
}
pub(crate) use concat_slices;

pub mod action;
pub mod actions;
pub mod apps;
pub mod catalogue;
pub mod census;
pub mod chat;
pub mod civil;
pub mod denial;
pub mod error;
pub mod grammar;
pub mod kind;
pub mod manifest;
pub mod money;
pub mod page;
pub mod read;
pub mod reads;
pub mod row;
pub mod spelling;
pub mod statement;
pub mod testdoor;

pub use denial::{Denial, Reading, denial_of};
pub use error::{KitError, KitResult};
pub use page::{MAX_PAGE_ROWS, Page, PageCursor, PageRequest, page_of, probe_limit};
pub use reads::{
    FanOutBound, JOIN_FAN_OUT, PageDoor, Window, in_list, read_by_id, read_page, read_pages,
    read_window,
};
pub use row::{Cell, Row};
pub use statement::{
    PageBindValue, PageOrder, PageQuery, page_cursor_boundary, page_cursor_of, page_statement,
};

pub use action::ActionDecl;
pub use kind::KindDecl;
pub use read::ReadDecl;

/// Every kind the apps declare: one row per vault entity kind.
pub const KINDS: &[KindDecl] = apps::KINDS;
/// Every action: one row per vault command a member or the assistant intends.
pub const ACTIONS: &[ActionDecl] = catalogue::ACTIONS;
/// Every registered read.
pub const READS: &[ReadDecl] = apps::READS;
