//! Literal previews use existing owned bytes without migrating or mutating old records.

use super::*;
use centraid_apps_docs::bytes::MAX_QUICK_LOOK_BYTES;

const AUDIT_TEXT: &str =
    "Disposable Centraid emulator attachment.\nUsed only for the issue 1185 Android audit.\n";

fn changes(scratch: &Scratch) -> u64 {
    scratch
        .handle
        .with_vault(|vault| Ok(vault.read(|connection| Ok(connection.total_changes()))?))
        .expect("the vault's row-change count reads")
}

fn path(scratch: &Scratch, id: &str) -> std::path::PathBuf {
    scratch
        .handle
        .with_vault(|vault| Ok(vault.content_location(id)?))
        .expect("the location reads")
        .path
        .expect("owned bytes")
}

#[test]
fn existing_and_new_plain_text_files_preview_without_writing_or_changing_bytes() {
    let scratch = Scratch::founded();
    assert_eq!(AUDIT_TEXT.len(), 85);
    let old = scratch.add_bytes(
        "centraid-audit-attachment.txt",
        AUDIT_TEXT.as_bytes(),
        "text/plain",
        None,
    );
    let old_path = path(&scratch, &old);
    let before = changes(&scratch);
    assert_eq!(scratch.document(&old).body.as_deref(), Some(AUDIT_TEXT));
    assert_eq!(scratch.document(&old).body.as_deref(), Some(AUDIT_TEXT));
    assert_eq!(
        changes(&scratch),
        before,
        "previewing does not backfill or commit"
    );
    assert_eq!(std::fs::read(old_path).unwrap(), AUDIT_TEXT.as_bytes());

    let new = scratch.add_bytes("new.txt", b"A newly picked file.\n", "text/plain", None);
    assert_eq!(
        scratch.document(&new).body.as_deref(),
        Some("A newly picked file.\n")
    );
}

#[test]
fn safe_text_formats_and_mime_parameters_share_the_existing_reader_policy() {
    let scratch = Scratch::founded();
    for (media_type, text) in [
        (
            "text/markdown",
            "# A heading\n\n**Literal text** <script>no execution</script>\n",
        ),
        (
            "TEXT/PLAIN; charset=UTF-8",
            "\u{feff}Hello, 世界 🌍\r\nSecond line\tvalue\n",
        ),
        (
            " text/markdown ; charset=UTF-8",
            "# Whitespace around a MIME type\n",
        ),
        ("text/csv", "name,value\nTea,3\n"),
        ("text/tab-separated-values", "name\tvalue\nTea\t3\n"),
        ("text/x-log", "Line one\nLine two\n"),
    ] {
        let id = scratch.add_bytes("words", text.as_bytes(), media_type, None);
        let document = scratch.document(&id);
        assert_eq!(
            document.document.as_ref().unwrap().surface(),
            wire::DocsSurface::Reading,
            "{media_type} must reach the reader"
        );
        assert_eq!(
            document.body.as_deref(),
            Some(text.trim_start_matches('\u{feff}')),
            "{media_type}"
        );
        assert_eq!(
            std::fs::read(path(&scratch, &id)).unwrap(),
            text.as_bytes(),
            "BOM and bytes stay intact"
        );
    }
    let empty = scratch.add_bytes("empty.txt", b"", "text/plain", None);
    assert_eq!(
        scratch.document(&empty).body.as_deref(),
        Some(""),
        "blank is readable, not unavailable"
    );
}

#[test]
fn invalid_utf8_binary_controls_and_nontext_files_have_no_text_preview() {
    let scratch = Scratch::founded();
    for (media_type, bytes) in [
        ("text/plain", b"bad\xffutf8".as_slice()),
        ("text/plain", b"binary\0payload".as_slice()),
        ("text/plain", b"escape\x1bpayload".as_slice()),
        (
            "application/octet-stream",
            b"ASCII bytes are not a text MIME".as_slice(),
        ),
        ("application/pdf", b"%PDF-1.7".as_slice()),
    ] {
        let id = scratch.add_bytes("file.txt", bytes, media_type, None);
        assert!(
            scratch.document(&id).body.is_none(),
            "{media_type} {bytes:?}"
        );
    }
}

#[test]
fn executable_mime_types_are_not_read_even_if_their_bytes_are_valid_utf8() {
    let scratch = Scratch::founded();
    for media_type in [
        "text/html",
        "TEXT/HTML; charset=utf-8",
        "application/xhtml+xml",
        "Application/Xhtml+Xml; charset=utf-8",
        "image/svg+xml",
        "IMAGE/SVG+XML; charset=utf-8",
    ] {
        let id = scratch.add_bytes(
            "file.txt",
            b"<script>no execution</script>",
            media_type,
            None,
        );
        let document = scratch.document(&id);
        assert!(document.body.is_none(), "{media_type}");
        assert!(
            document.bytes_path.is_empty(),
            "unsafe types never get an inline path"
        );
    }
}

#[test]
fn the_preview_accepts_the_exact_bound_and_never_returns_an_oversize_prefix() {
    let scratch = Scratch::founded();
    let exact = vec![b'a'; MAX_QUICK_LOOK_BYTES];
    let id = scratch.add_bytes("exact.txt", &exact, "text/plain", None);
    assert_eq!(
        scratch.document(&id).body.unwrap().len(),
        MAX_QUICK_LOOK_BYTES
    );
    let oversized = vec![b'a'; MAX_QUICK_LOOK_BYTES + 1];
    let id = scratch.add_bytes("large.txt", &oversized, "text/plain", None);
    assert!(scratch.document(&id).body.is_none());
    let mut reader = std::io::Cursor::new(vec![b'a'; MAX_QUICK_LOOK_BYTES * 2]);
    assert!(
        super::super::read_text_preview(&mut reader, "unused for oversized data")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        reader.position(),
        (MAX_QUICK_LOOK_BYTES + 1) as u64,
        "actual reads are bounded independently of metadata"
    );
}

#[test]
fn edited_text_derivatives_and_empty_bodies_remain_authoritative() {
    let scratch = Scratch::founded();
    let id = scratch.add_bytes(
        "editable.txt",
        b"Original picked bytes.\n",
        "TEXT/PLAIN; charset=UTF-8",
        None,
    );
    let original_path = path(&scratch, &id);
    let revision = scratch.document(&id).rev;
    scratch.run(
        "document.edit",
        serde_json::json!({ "id": id, "body_text": "Edited in Docs.\n", "expected_rev": revision }),
    );
    assert_eq!(
        scratch.document(&id).body.as_deref(),
        Some("Edited in Docs.\n")
    );
    assert_eq!(
        std::fs::read(original_path).unwrap(),
        b"Original picked bytes.\n"
    );
    assert_eq!(
        scratch.document(&id).document.as_ref().unwrap().media_type,
        "TEXT/PLAIN; charset=UTF-8",
        "editing preserves the stated media type"
    );
    let current_path = path(&scratch, &id);
    std::fs::remove_file(current_path).unwrap();
    assert_eq!(
        scratch.document(&id).body.as_deref(),
        Some("Edited in Docs.\n"),
        "the stored derivative is preferred even when raw bytes are absent"
    );
    let blank = scratch.add("Blank", "", None);
    std::fs::remove_file(path(&scratch, &blank)).unwrap();
    assert_eq!(scratch.document(&blank).body.as_deref(), Some(""));
}

#[test]
fn replacing_an_uploaded_file_previews_the_new_head_and_keeps_the_old_bytes() {
    let scratch = Scratch::founded();
    let id = scratch.add_bytes("replace.txt", b"First head\n", "text/plain", None);
    let old = path(&scratch, &id);
    let next = scratch.stage(b"Second head\n", "text/plain");
    scratch.run(
        "document.replace",
        serde_json::json!({ "id": id, "blob": next, "media_type": "text/plain", "size": b"Second head\n".len() }),
    );
    let before = changes(&scratch);
    let document = scratch.document(&id);
    assert_eq!(document.body.as_deref(), Some("Second head\n"));
    assert!(document.versions.len() >= 2);
    assert_eq!(std::fs::read(old).unwrap(), b"First head\n");
    assert_eq!(changes(&scratch), before);
}

#[test]
fn missing_bytes_are_unavailable_and_corrupt_or_failed_reads_are_errors() {
    let scratch = Scratch::founded();
    let missing = scratch.add_bytes("missing.txt", b"Missing body\n", "text/plain", None);
    std::fs::remove_file(path(&scratch, &missing)).unwrap();
    let document = scratch.document(&missing);
    assert!(document.body.is_none() && !document.bytes_held);
    let corrupt = scratch.add_bytes("corrupt.txt", b"Good body\n", "text/plain", None);
    std::fs::write(path(&scratch, &corrupt), b"Bad body!\n").unwrap();
    assert!(matches!(
        scratch.ask(wire::app_query_request::Query::DocsDocument(
            wire::DocsDocumentRequest {
                document_id: corrupt,
                tz: TZ.to_owned()
            }
        )),
        Err(CoreError::Invariant { .. })
    ));
    struct Broken;
    impl std::io::Read for Broken {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("test read failure"))
        }
    }
    assert!(matches!(
        super::super::read_text_preview(Broken, "unused on I/O failure"),
        Err(CoreError::Vault(centraid_vault::VaultError::Io(_)))
    ));
}

#[test]
fn editing_nontext_files_stays_refused_even_when_their_bytes_decode() {
    let scratch = Scratch::founded();
    for media_type in [
        "application/octet-stream",
        "APPLICATION/PDF",
        "IMAGE/SVG+XML; charset=utf-8",
    ] {
        let id = scratch.add_bytes("file.txt", b"some bytes", media_type, None);
        let answer = scratch
            .handle
            .command(
                "document.edit",
                &serde_json::json!({ "id": id, "body_text": "not permitted" }),
                &format!("refused-{media_type}"),
            )
            .expect("a typed refusal");
        assert_eq!(answer.status, centraid_vault::CommandStatus::Failed);
        assert!(
            answer
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("replace its bytes"))
        );
        assert_eq!(std::fs::read(path(&scratch, &id)).unwrap(), b"some bytes");
    }
}
