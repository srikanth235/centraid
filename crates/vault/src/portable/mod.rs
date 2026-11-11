//! WHAT LEAVES THE VAULT AS A FILE (#1185): the pieces every export shares. Today that is the
//! streaming archive writer ([`zip`]); the commands that choose what goes in stay with their
//! kind (`commands::note_portable`, `commands::document_portable`).

pub mod zip;
