//! WHAT A DOCUMENT IS TO A MEMBER — its kind, which screen opens it, and which
//! Type pill it passes (#1046).
//!
//! v0 classified in `format.ts` (`typeMeta`, `canRender`, `isTextKind`) and in
//! `filters.ts` (`TYPE_PREDICATE`), in each shell's JavaScript. A v1 shell has
//! no second copy to hold, so the table lives here once and the core answers
//! the classification with every row: **media type first, the title's
//! extension second, never the reverse** — Office files sniff as ZIP or
//! `octet-stream`, and a name is the only thing that says what they are.

/// v0's eight kinds (`format.ts`'s `KINDS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    Pdf,
    Image,
    Video,
    Audio,
    Spreadsheet,
    Presentation,
    Document,
    Other,
}

impl Kind {
    /// The word the Kind column prints.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Pdf => "PDF",
            Self::Image => "Image",
            Self::Video => "Video",
            Self::Audio => "Audio",
            Self::Spreadsheet => "Spreadsheet",
            Self::Presentation => "Presentation",
            Self::Document => "Document",
            Self::Other => "File",
        }
    }
}

/// Which of the three document screens opens a document (v0's
/// `readSurfaceFor`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    /// `text/*`: the reader, over the decoded body — and the editor, because
    /// `core.edit_document` accepts exactly `text/%` (the lockstep v0 states).
    Reading,
    /// An image, audio, video or PDF: the stage, over the bytes.
    Stage,
    /// Everything else: the facts sheet. Docs converts nothing.
    Facts,
}

/// v0's Type pills (`filters.ts`'s `TYPE_PREDICATE`), in its order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeFilter {
    Pdf,
    Image,
    /// The `Document` kind — word processors and every `text/*`.
    Word,
    Spreadsheet,
    Markdown,
    Text,
    Audio,
    Video,
}

fn kind_from_media_type(media_type: &str) -> Option<Kind> {
    let t = media_type;
    if t == "application/pdf" {
        return Some(Kind::Pdf);
    }
    if t.starts_with("video/") {
        return Some(Kind::Video);
    }
    if t.starts_with("audio/") {
        return Some(Kind::Audio);
    }
    if t.starts_with("image/") {
        return Some(Kind::Image);
    }
    if t.contains("spreadsheet")
        || t == "application/vnd.ms-excel"
        || t == "text/csv"
        || t == "application/vnd.oasis.opendocument.spreadsheet"
    {
        return Some(Kind::Spreadsheet);
    }
    if t.contains("presentation")
        || t == "application/vnd.ms-powerpoint"
        || t == "application/vnd.oasis.opendocument.presentation"
    {
        return Some(Kind::Presentation);
    }
    if t.contains("word")
        || t == "application/msword"
        || t == "application/vnd.oasis.opendocument.text"
        || t == "application/rtf"
        || t.starts_with("text/")
    {
        return Some(Kind::Document);
    }
    None
}

fn kind_from_name(name: &str) -> Option<Kind> {
    let dot = name.rfind('.')?;
    if dot == 0 || dot + 1 >= name.len() {
        return None;
    }
    Some(match name[dot + 1..].to_ascii_lowercase().as_str() {
        "pdf" => Kind::Pdf,
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif" | "heic" | "heif" | "tif" | "tiff"
        | "bmp" | "svg" => Kind::Image,
        "mp4" | "mov" | "m4v" | "webm" | "avi" | "mkv" => Kind::Video,
        "mp3" | "m4a" | "wav" | "aac" | "flac" | "ogg" | "oga" | "opus" => Kind::Audio,
        "xlsx" | "xls" | "xlsm" | "ods" | "csv" | "tsv" | "numbers" => Kind::Spreadsheet,
        "pptx" | "ppt" | "odp" | "key" => Kind::Presentation,
        "docx" | "doc" | "odt" | "rtf" | "pages" | "md" | "markdown" | "txt" | "text" | "log"
        | "json" | "xml" => Kind::Document,
        _ => return None,
    })
}

/// A document's kind: media type first, title second, else `Other`.
#[must_use]
pub fn kind_of(media_type: Option<&str>, title: Option<&str>) -> Kind {
    let media_type = media_type.unwrap_or_default().to_ascii_lowercase();
    kind_from_media_type(&media_type)
        .or_else(|| kind_from_name(title.unwrap_or_default()))
        .unwrap_or(Kind::Other)
}

fn is_text(media_type: Option<&str>) -> bool {
    media_type
        .unwrap_or_default()
        .to_ascii_lowercase()
        .starts_with("text/")
}

/// Which screen opens it. ANY `text/*` document reads — a `text/csv` too, as
/// v0's `readSurfaceFor` checks text before kind — because the reader and the
/// editor are the one pair `core.edit_document` (`text/%`) serves; a kind the
/// phone can draw stages; the rest is facts.
#[must_use]
pub fn surface_of(media_type: Option<&str>, title: Option<&str>) -> Surface {
    if is_text(media_type) {
        return Surface::Reading;
    }
    match kind_of(media_type, title) {
        Kind::Pdf | Kind::Image | Kind::Video | Kind::Audio => Surface::Stage,
        Kind::Spreadsheet | Kind::Presentation | Kind::Document | Kind::Other => Surface::Facts,
    }
}

impl TypeFilter {
    /// Whether a document passes this pill.
    #[must_use]
    pub fn admits(self, media_type: Option<&str>, title: Option<&str>) -> bool {
        let lowered = media_type.unwrap_or_default().to_ascii_lowercase();
        let kind = kind_of(media_type, title);
        match self {
            Self::Pdf => kind == Kind::Pdf,
            Self::Image => kind == Kind::Image,
            Self::Word => kind == Kind::Document,
            Self::Spreadsheet => kind == Kind::Spreadsheet,
            Self::Markdown => lowered.starts_with("text/markdown"),
            Self::Text => lowered == "text/plain",
            Self::Audio => lowered.starts_with("audio/"),
            Self::Video => lowered.starts_with("video/"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_type_wins_over_the_title_and_the_title_is_the_fallback() {
        assert_eq!(kind_of(Some("image/png"), Some("lease.pdf")), Kind::Image);
        assert_eq!(
            kind_of(Some("application/octet-stream"), Some("Budget.XLSX")),
            Kind::Spreadsheet
        );
        assert_eq!(kind_of(None, Some("no-extension")), Kind::Other);
        assert_eq!(kind_of(None, Some(".hidden")), Kind::Other);
        assert_eq!(Kind::Other.name(), "File");
    }

    #[test]
    fn text_reads_media_stages_and_the_rest_is_facts() {
        assert_eq!(surface_of(Some("text/markdown"), None), Surface::Reading);
        assert_eq!(surface_of(Some("application/pdf"), None), Surface::Stage);
        assert_eq!(surface_of(Some("video/mp4"), None), Surface::Stage);
        assert_eq!(surface_of(Some("text/csv"), None), Surface::Reading);
        assert_eq!(
            surface_of(Some("application/msword"), Some("a.doc")),
            Surface::Facts
        );
        // A title alone never makes a document readable: the reader needs the
        // decoded body, and only a `text/*` representation has one.
        assert_eq!(surface_of(None, Some("notes.txt")), Surface::Facts);
    }

    #[test]
    fn the_type_pills_are_v0s_predicates() {
        assert!(TypeFilter::Word.admits(Some("text/plain"), None));
        assert!(TypeFilter::Text.admits(Some("text/plain"), None));
        assert!(!TypeFilter::Text.admits(Some("text/markdown"), None));
        assert!(TypeFilter::Markdown.admits(Some("text/markdown; charset=utf-8"), None));
        assert!(TypeFilter::Pdf.admits(None, Some("scan.pdf")));
        assert!(!TypeFilter::Audio.admits(None, Some("song.mp3")));
    }
}
