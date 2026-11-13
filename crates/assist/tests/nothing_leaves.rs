//! NOTHING LEAVES THE DEVICE. The assistant's questions, the vault text it reads and its answers are
//! handled on the phone: the crate that runs the turn depends on no network library, and neither it,
//! the core's assistant module nor the chat screen names a socket or an HTTP client. The one fetch
//! the chat makes, the model file, is an effect the shell performs (#1188).

use std::path::{Path, PathBuf};

const NETWORK_CRATES: [&str; 9] = [
    "reqwest", "hyper", "ureq", "tokio", "socket2", "curl", "rustls", "isahc", "surf",
];

const NETWORK_SYMBOLS: [&str; 6] = [
    "std::net::",
    "TcpStream",
    "UdpSocket",
    "reqwest::",
    "hyper::",
    "tokio::net",
];

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

fn product(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap();
    match text.find("#[cfg(test)]") {
        Some(at) => text[..at].to_owned(),
        None => text,
    }
}

#[test]
fn the_assistant_crate_depends_on_no_network_library() {
    let manifest =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")).unwrap();
    let deps = manifest
        .split("[dev-dependencies]")
        .next()
        .unwrap()
        .to_owned();
    for name in NETWORK_CRATES {
        assert!(
            !deps.lines().any(|line| line.trim_start().starts_with(name)),
            "the assistant crate depends on `{name}`"
        );
    }
}

#[test]
fn no_assistant_or_chat_source_names_a_socket_or_an_http_client() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = Vec::new();
    sources(&root.join("assist/src"), &mut files);
    sources(&root.join("core/src/assist"), &mut files);
    sources(&root.join("screens/src/chat"), &mut files);
    assert!(files.len() > 10, "the walk found the sources");
    for file in files {
        let text = product(&file);
        for symbol in NETWORK_SYMBOLS {
            assert!(
                !text.contains(symbol),
                "{} names `{symbol}`",
                file.display()
            );
        }
    }
}
