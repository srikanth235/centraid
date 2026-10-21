//! The schema authority: open a vault file, know its shape, verify it.
//!
//! This crate is deliberately narrow ([#1020](https://github.com/srikanth235/centraid/issues/1020),
//! [#1135](https://github.com/srikanth235/centraid/issues/1135)). It opens a
//! file, renders its DDL as the committed fixture, and answers two engine-level
//! soundness questions. The model itself, with its kinds, relations and
//! registries, is `crates/vault`'s baseline and `docs/vault-ontology.md`; there
//! is no second copy of it here.

#![forbid(unsafe_code)]

pub mod ddl;
pub mod doctor;
pub mod error;
pub mod jsvalue;
pub mod scratch;
pub mod vault;

pub use ddl::{DDL_FIXTURE_HEADER, ddl_fixture, render_ddl, render_ddl_objects};
pub use doctor::{DoctorReport, format_doctor_report, vault_doctor};
pub use error::{OntologyError, Result};
pub use vault::{ONTOLOGY_VERSION, SchemaObject, Vault, schema_objects_of};
