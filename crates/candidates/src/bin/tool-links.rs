//! Print the links paragraph of `experiments/toolchat/TOOLS.md` from the
//! executor's edge table (`crate::exec::EDGES`). With `--write`, splice it
//! into TOOLS.md between its `<!-- links` markers; the test
//! `tools_md_links_match_the_edge_table` fails while the two differ.

fn main() {
    let block = centraid_candidates::exec::links_paragraph();
    if std::env::args().any(|arg| arg == "--write") {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../experiments/toolchat/TOOLS.md"
        );
        let text = std::fs::read_to_string(path).expect("TOOLS.md is readable");
        let spliced = centraid_candidates::exec::splice_links(&text, &block)
            .expect("TOOLS.md carries the links markers (or a bare LINKS line)");
        std::fs::write(path, spliced).expect("TOOLS.md is writable");
    } else {
        print!("{block}");
    }
}
