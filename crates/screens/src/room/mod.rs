//! THE ROOM BUILDERS (app-plane §1, §5, §6): Rust types and a builder for every block, slot and
//! canvas of `room.proto`; the selector allocator and its handler map; the shared text field's
//! state; keep-my-place; and the runtime that holds a stack of rooms per tab.
//!
//! A screen implements [`RoomScreen`] and returns a `Room` built from its typed reads.
//! The shells draw the room and send `RoomEvent`s; the runtime routes each through the
//! handler map the build made.

pub mod blocks;
pub mod door;
pub mod field;
pub mod form;
pub mod frame;
pub mod host;
pub mod notify_words;
pub mod people;
pub mod rooms;
pub mod screen;
pub mod selector;
pub mod shell;
pub mod snapshot;
pub mod ui;

pub use door::{Done, Door, Refused};
pub use host::RoomRuntime;
pub use rooms::{Move, Refusal, Rooms, Shown};
pub use screen::{Build, Event, Input, Nav, Outcome, Registry, RoomScreen, Status};
pub use selector::{Act, Handler, HandlerMap, RoomError, Sel};
pub use ui::{Place, Scroll, Ui};
