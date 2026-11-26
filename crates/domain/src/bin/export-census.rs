//! Writes the action census to stdout: one row for every action, and how chat reaches it.
//!
//! `cargo run -p centraid-domain --bin export-census > contracts/assist/catalog-census.csv`

fn main() {
    print!("{}", centraid_domain::census::csv());
}
