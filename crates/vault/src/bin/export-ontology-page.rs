//! Re-render the published ontology page's schema section in place.
//!
//! ```sh
//! cargo run -p centraid-vault --bin export-ontology-page
//! ```
//!
//! It takes the page at `scripts/docs-site/src/content/ontology-body.html`
//! (from the repository root) and replaces what is between its `schema:` markers
//! with what `centraid_vault::ontology_doc` renders from a vault founded by this
//! build. `tests/ontology_page.rs` diffs the same render, so a stale page is red.

use std::process::ExitCode;

fn main() -> ExitCode {
    let path = centraid_ontology::scratch::repo_root()
        .join("scripts/docs-site/src/content/ontology-body.html");
    let result = (|| -> Result<(), String> {
        let page = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let block = centraid_vault::ontology_doc::render_schema_section()
            .map_err(|error| error.to_string())?;
        let spliced = centraid_vault::ontology_doc::splice(&page, &block)
            .ok_or("the page has no schema markers")?;
        std::fs::write(&path, spliced).map_err(|error| error.to_string())
    })();
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("export-ontology-page: {error}");
            ExitCode::FAILURE
        }
    }
}
