//! RICH NOTES: a note's Markdown body (the text stays the source of truth)
//! turned into the styled blocks and spans a native editor draws, plus the
//! pure text edits for toggling a checklist item and for Return continuation.
//! Nothing here does I/O or knows the wire.
//!
//! **RANGE UNIT: UTF-16 code units**, half-open `[start, end)`, as `u32`. That
//! is `NSString`'s unit on iOS and Kotlin's `Char` on Android, so a shell
//! applies a range with no conversion. An emoji or other supplementary
//! character counts 2, and a range never splits a surrogate pair (every range
//! starts and ends beside an ASCII delimiter or a line edge).
//!
//! **One pass, line by line.** Lines split on `\n`; a trailing `\r` belongs to
//! the terminator and is never inside a range. A line is classified (heading,
//! checklist, bullet, quote, paragraph) and its content parsed for inline
//! styles left to right. Blank (whitespace-only) lines produce no block.
//!
//! **Bounded by construction.** Only the first [`MAX_UTF16`] units are
//! parsed, ending at the last complete line inside that window; blocks and
//! spans stop at [`MAX_BLOCKS`] / [`MAX_SPANS`]; any bound sets
//! `truncated` and the rest is plain. An opener looks for its closer at most
//! [`MAX_INLINE_LOOKAHEAD`] units ahead and never past its line, and every
//! closer search is memoised per line (see [`Finder`]), so a line of 100k
//! `*` or `[` costs a constant number of examinations per unit. [`Rich::work`]
//! counts every unit examined and the tests assert `work <= WORK_FACTOR *
//! length + SLACK` (`WORK_FACTOR` is 16: per unit, one for the window copy, the line scan, the
//! inline walk, a delimiter run and a bare URL, plus at most one for each of
//! the 11 closer searches, whose memoisation examines a unit once per kind).
//!
//! Choices the grammar left open:
//! - Nested wiki openers: the INNERMOST valid pair wins. A `[[` whose title
//!   would contain another `[` is not a link; the scan moves on and the inner
//!   `[[b]]` is.
//! - A markdown link's URL ends at the FIRST `)` (so `(a(b))` is cut short),
//!   may not contain whitespace, and its label may not contain `[`.
//! - A bare URL runs to whitespace, minus trailing punctuation and trailing
//!   emphasis marks (`*`, `_`, `~`), so `**http://x**` is a strong span over
//!   the URL, whose link is `http://x`; a mark inside the URL (`a_b`) stays.
//!   `***x***` is not specially handled.
//! - Styled spans may contain links and code; emphasis closers are matched
//!   once, so an emphasis whose closer sits inside a code span or link is plain.
//! - [`toggle`] writes a lowercase `x`: `[X]` toggles to `[ ]` and back to `[x]`.

/// The parse window, in UTF-16 units; past it the rest is plain.
pub(crate) const MAX_UTF16: usize = 200_000;
pub(crate) const MAX_BLOCKS: usize = 4_000;
pub(crate) const MAX_SPANS: usize = 8_000;
/// Distinct `[[titles]]` collected for resolution.
pub(crate) const MAX_WIKI_TITLES: usize = 32;
/// UTF-16 units an opener may search for its closer.
pub(crate) const MAX_INLINE_LOOKAHEAD: usize = 1_024;
/// The most emphasis openers waiting for their closer on one line.
const MAX_PENDING: usize = 16;
/// Digits a numbered item may have (keeps the next number inside `u64`).
const MAX_DIGITS: usize = 9;

/// A half-open UTF-16 range.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub(crate) struct Range {
    pub start: u32,
    pub end: u32,
}

impl Range {
    fn of(start: usize, end: usize) -> Self {
        Self {
            start: to_u32(start),
            end: to_u32(end),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BlockKind {
    Paragraph,
    Heading,
    Checklist,
    Bullet,
    Quote,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Block {
    pub kind: BlockKind,
    /// The whole line, WITHOUT its `\n` / `\r\n` terminator.
    pub range: Range,
    /// Checklist: the 3 units `[ ]`/`[x]`; bullet: the `-`/`*`/`+` (or `1.`);
    /// heading: the `#`s; quote: `>`.
    pub marker: Option<Range>,
    /// The text after the marker and its following space (an empty range at
    /// the line's end if none).
    pub content: Range,
    /// Heading: 1..=6; list/checklist: indent depth (each tab or 2 spaces is
    /// 1); else 0.
    pub level: u32,
    /// Checklist only.
    pub checked: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SpanStyle {
    Emphasis,
    Strong,
    Strike,
    Code,
    Syntax,
    Link,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LinkTarget {
    Url(String),
    Wiki(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Link {
    pub label: String,
    pub target: LinkTarget,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Span {
    pub range: Range,
    pub style: SpanStyle,
    /// Present on `Link` spans only.
    pub link: Option<Link>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Rich {
    /// One per non-blank line, in order.
    pub blocks: Vec<Block>,
    /// Sorted by `range.start`.
    pub spans: Vec<Span>,
    /// A bound was hit; the rest is plain.
    pub truncated: bool,
    /// Distinct wiki titles in first-seen order, at most [`MAX_WIKI_TITLES`].
    pub wiki_titles: Vec<String>,
    /// The WHOLE body's UTF-16 length, not just the parsed window.
    pub length: u32,
    /// Units examined while parsing; bounded by construction.
    pub work: usize,
}

/// The body's length in UTF-16 units.
pub(crate) fn utf16_len(text: &str) -> u32 {
    to_u32(text.encode_utf16().count())
}

fn to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn to_index(n: u32) -> usize {
    usize::try_from(n).unwrap_or(usize::MAX)
}

const LF: u16 = b'\n' as u16;
const CR: u16 = b'\r' as u16;
const SP: u16 = b' ' as u16;
const TAB: u16 = b'\t' as u16;
const HASH: u16 = b'#' as u16;
const QUOTE: u16 = b'>' as u16;
const STAR: u16 = b'*' as u16;
const UNDER: u16 = b'_' as u16;
const TILDE: u16 = b'~' as u16;
const TICK: u16 = b'`' as u16;
const LBRACKET: u16 = b'[' as u16;
const RBRACKET: u16 = b']' as u16;
const LPAREN: u16 = b'(' as u16;
const RPAREN: u16 = b')' as u16;
const LOWER_X: u16 = b'x' as u16;
const UPPER_X: u16 = b'X' as u16;

fn is_high(unit: u16) -> bool {
    (0xD800..0xDC00).contains(&unit)
}

fn is_low(unit: u16) -> bool {
    (0xDC00..0xE000).contains(&unit)
}

fn is_space(unit: Option<u16>) -> bool {
    unit.and_then(|u| char::from_u32(u32::from(u)))
        .is_some_and(char::is_whitespace)
}

fn is_alnum(unit: Option<u16>) -> bool {
    unit.and_then(|u| char::from_u32(u32::from(u)))
        .is_some_and(char::is_alphanumeric)
}

fn is_digit(unit: Option<u16>) -> bool {
    unit.is_some_and(|u| (u16::from(b'0')..=u16::from(b'9')).contains(&u))
}

fn text(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn lower(unit: u16) -> u16 {
    if (u16::from(b'A')..=u16::from(b'Z')).contains(&unit) {
        unit + 32
    } else {
        unit
    }
}

/// Whether `units` begins with the ASCII `prefix`, ignoring case.
fn starts_with_ci(units: &[u16], prefix: &str) -> bool {
    let mut it = units.iter();
    prefix
        .bytes()
        .all(|b| it.next().is_some_and(|&u| lower(u) == u16::from(b)))
}

/// The length of the scheme a link may carry (`http://`, `https://`,
/// `mailto:`); anything else (`javascript:`, `data:`...) is never a link.
fn link_scheme_len(units: &[u16]) -> Option<usize> {
    ["https://", "http://", "mailto:"]
        .into_iter()
        .find(|scheme| starts_with_ci(units, scheme))
        .map(str::len)
}

// ---------------------------------------------------------------- blocks

/// Classify ONE line `[start, end)` of `u` (terminator already removed).
/// A whitespace-only line is no block.
fn classify(u: &[u16], start: usize, end: usize) -> Option<Block> {
    let at = |i: usize| if i < end { u.get(i).copied() } else { None };
    if u.get(start..end)?.iter().all(|&c| is_space(Some(c))) {
        return None;
    }
    let after_space = |i: usize| if at(i) == Some(SP) { i + 1 } else { i };
    let block =
        |kind, marker: Option<(usize, usize)>, content: usize, level: usize, checked| Block {
            kind,
            range: Range::of(start, end),
            marker: marker.map(|(s, e)| Range::of(s, e)),
            content: Range::of(content.min(end), end),
            level: to_u32(level),
            checked,
        };

    if at(start) == Some(HASH) {
        let mut n = 0;
        while n < 7 && at(start + n) == Some(HASH) {
            n += 1;
        }
        if n <= 6 && matches!(at(start + n), None | Some(SP)) {
            let marker = Some((start, start + n));
            return Some(block(
                BlockKind::Heading,
                marker,
                after_space(start + n),
                n,
                false,
            ));
        }
    }
    if at(start) == Some(QUOTE) {
        let marker = Some((start, start + 1));
        return Some(block(
            BlockKind::Quote,
            marker,
            after_space(start + 1),
            0,
            false,
        ));
    }

    let (mut tabs, mut spaces) = (0, 0);
    let mut i = start;
    while let Some(c) = at(i).filter(|&c| c == SP || c == TAB) {
        if c == TAB {
            tabs += 1;
        } else {
            spaces += 1;
        }
        i += 1;
    }
    let level = tabs + spaces / 2;

    if matches!(at(i), Some(c) if c == STAR || c == u16::from(b'-') || c == u16::from(b'+'))
        && at(i + 1) == Some(SP)
    {
        let boxed = at(i + 2) == Some(LBRACKET)
            && matches!(at(i + 3), Some(c) if c == SP || c == LOWER_X || c == UPPER_X)
            && at(i + 4) == Some(RBRACKET)
            && matches!(at(i + 5), None | Some(SP));
        if boxed {
            let checked = at(i + 3) != Some(SP);
            let marker = Some((i + 2, i + 5));
            return Some(block(
                BlockKind::Checklist,
                marker,
                after_space(i + 5),
                level,
                checked,
            ));
        }
        return Some(block(
            BlockKind::Bullet,
            Some((i, i + 1)),
            i + 2,
            level,
            false,
        ));
    }

    let mut digits = 0;
    while digits <= MAX_DIGITS && is_digit(at(i + digits)) {
        digits += 1;
    }
    if (1..=MAX_DIGITS).contains(&digits)
        && matches!(at(i + digits), Some(c) if c == u16::from(b'.') || c == RPAREN)
        && at(i + digits + 1) == Some(SP)
    {
        return Some(block(
            BlockKind::Bullet,
            Some((i, i + digits + 1)),
            i + digits + 2,
            level,
            false,
        ));
    }
    Some(block(BlockKind::Paragraph, None, i, 0, false))
}

// ---------------------------------------------------------------- inline

/// What a closer search looks for. Every predicate depends on the position
/// alone, which is what lets [`Finder`] remember what it has already seen.
#[derive(Clone, Copy)]
enum Kind {
    StrongStar,
    EmphStar,
    StrongUnder,
    EmphUnder,
    Strike,
    Tick,
    CloseBracket,
    OpenBracket,
    CloseWiki,
    CloseParen,
    Space,
}

const KINDS: usize = 11;

/// ONE LINE's view of the units: lookbehind and lookahead never leave
/// `[lo, hi)`, so a construct never crosses a line or reads the marker.
#[derive(Clone, Copy)]
struct Line<'a> {
    u: &'a [u16],
    lo: usize,
    hi: usize,
}

impl Line<'_> {
    fn at(&self, i: usize) -> Option<u16> {
        if i >= self.lo && i < self.hi {
            self.u.get(i).copied()
        } else {
            None
        }
    }

    fn before(&self, i: usize) -> Option<u16> {
        i.checked_sub(1).and_then(|j| self.at(j))
    }

    fn hit(&self, kind: Kind, q: usize) -> bool {
        let (c, next, prev) = (self.at(q), self.at(q + 1), self.before(q));
        match kind {
            Kind::StrongStar => c == Some(STAR) && next == Some(STAR) && !is_space(prev),
            Kind::EmphStar => {
                c == Some(STAR) && prev != Some(STAR) && next != Some(STAR) && !is_space(prev)
            }
            Kind::StrongUnder => {
                c == Some(UNDER)
                    && next == Some(UNDER)
                    && !is_space(prev)
                    && !is_alnum(self.at(q + 2))
            }
            Kind::EmphUnder => {
                c == Some(UNDER)
                    && prev != Some(UNDER)
                    && next != Some(UNDER)
                    && !is_space(prev)
                    && !is_alnum(next)
            }
            Kind::Strike => c == Some(TILDE) && next == Some(TILDE) && !is_space(prev),
            Kind::Tick => c == Some(TICK),
            Kind::CloseBracket => c == Some(RBRACKET),
            Kind::OpenBracket => c == Some(LBRACKET),
            Kind::CloseWiki => c == Some(RBRACKET) && next == Some(RBRACKET),
            Kind::CloseParen => c == Some(RPAREN),
            Kind::Space => is_space(c),
        }
    }
}

/// A MEMOISED "first position at or after `start` where the predicate holds".
/// An opener that finds no closer must not make the next opener rescan the
/// same units: `[`, `[[` and `*` repeated 100k times would cost a lookahead
/// each. `[from, scanned_to)` is known to hold no hit but `hit`, so every unit
/// is examined at most once per kind per line and the search stays linear.
#[derive(Clone, Copy, Default)]
struct Finder {
    from: usize,
    scanned_to: usize,
    hit: Option<usize>,
}

impl Finder {
    fn find(
        &mut self,
        work: &mut usize,
        start: usize,
        limit: usize,
        hit: impl Fn(usize) -> bool,
    ) -> Option<usize> {
        if start >= limit {
            return None;
        }
        let stale = start < self.from || self.hit.is_some_and(|h| h < start);
        if stale {
            *self = Self {
                from: start,
                scanned_to: start,
                hit: None,
            };
        }
        if let Some(h) = self.hit {
            return (h < limit).then_some(h);
        }
        let mut q = start.max(self.scanned_to);
        while q < limit {
            *work += 1;
            if hit(q) {
                self.hit = Some(q);
                self.scanned_to = q + 1;
                return Some(q);
            }
            q += 1;
        }
        self.scanned_to = self.scanned_to.max(limit);
        None
    }
}

/// What the whole parse accumulates.
#[derive(Default)]
struct Out {
    spans: Vec<Span>,
    titles: Vec<String>,
    truncated: bool,
    work: usize,
}

/// An emphasis opener whose closer is known; the spans are emitted only when
/// the scan REACHES the closer, so a closer swallowed by a code span or link
/// leaves the emphasis plain instead of half drawn.
struct Pending {
    open: usize,
    len: usize,
    close: usize,
    style: SpanStyle,
}

struct Inline<'a, 'o> {
    line: Line<'a>,
    finders: [Finder; KINDS],
    pending: Vec<Pending>,
    out: &'o mut Out,
}

impl Inline<'_, '_> {
    fn search(&mut self, kind: Kind, start: usize, limit: usize) -> Option<usize> {
        let line = self.line;
        self.finders[kind as usize].find(&mut self.out.work, start, limit, |q| line.hit(kind, q))
    }

    /// How far an opener at `p` may look: the lookahead, never past the line.
    fn limit(&self, p: usize) -> usize {
        (p + MAX_INLINE_LOOKAHEAD).min(self.line.hi)
    }

    fn room(&mut self, n: usize) -> bool {
        let fits = self.out.spans.len() + n <= MAX_SPANS;
        if !fits {
            self.out.truncated = true;
        }
        fits
    }

    fn push(&mut self, start: usize, end: usize, style: SpanStyle, link: Option<Link>) {
        self.out.spans.push(Span {
            range: Range::of(start, end),
            style,
            link,
        });
    }

    fn run(&mut self) {
        let mut p = self.line.lo;
        while p < self.line.hi {
            if self.out.spans.len() >= MAX_SPANS {
                self.out.truncated = true;
                return;
            }
            self.out.work += 1;
            let Some(c) = self.line.at(p) else { return };
            let next = match c {
                TICK => self.code(p),
                LBRACKET => self.bracket(p),
                STAR | UNDER | TILDE => Some(self.delim(p, c)),
                c if c == u16::from(b'h') || c == u16::from(b'H') => self.url(p),
                _ => None,
            };
            p = next.unwrap_or(p + 1);
        }
    }

    fn code(&mut self, p: usize) -> Option<usize> {
        let q = self.search(Kind::Tick, p + 1, self.limit(p))?;
        if q == p + 1 || !self.room(1) {
            return None;
        }
        self.push(p, q + 1, SpanStyle::Code, None);
        Some(q + 1)
    }

    fn bracket(&mut self, p: usize) -> Option<usize> {
        let limit = self.limit(p);
        let wiki = if self.line.at(p + 1) == Some(LBRACKET) {
            self.wiki(p, limit)
        } else {
            None
        };
        wiki.or_else(|| self.markdown_link(p, limit))
    }

    /// `[[Title]]`. A title holding another `[` is not this opener's: the
    /// INNERMOST valid pair wins, so `[[a [[b]]` links `[[b]]`.
    fn wiki(&mut self, p: usize, limit: usize) -> Option<usize> {
        let close = self.search(Kind::CloseWiki, p + 2, limit)?;
        if self.search(Kind::OpenBracket, p + 2, close).is_some() {
            return None;
        }
        let inner = self.line.u.get(p + 2..close)?;
        let lead = inner.iter().take_while(|&&c| is_space(Some(c))).count();
        let trail = inner
            .iter()
            .rev()
            .take_while(|&&c| is_space(Some(c)))
            .count();
        let title = text(inner.get(lead..inner.len().checked_sub(trail)?)?);
        if title.is_empty() || !self.room(1) {
            return None;
        }
        if self.out.titles.len() < MAX_WIKI_TITLES && !self.out.titles.contains(&title) {
            self.out.titles.push(title.clone());
        }
        let link = Link {
            label: title.clone(),
            target: LinkTarget::Wiki(title),
        };
        self.push(p, close + 2, SpanStyle::Link, Some(link));
        Some(close + 2)
    }

    /// `[label](url)`, ONLY for the schemes [`link_scheme_len`] names.
    fn markdown_link(&mut self, p: usize, limit: usize) -> Option<usize> {
        let close = self.search(Kind::CloseBracket, p + 1, limit)?;
        if close == p + 1 || self.line.at(close + 1) != Some(LPAREN) {
            return None;
        }
        if self.search(Kind::OpenBracket, p + 1, close).is_some() {
            return None;
        }
        let end = self.search(Kind::CloseParen, close + 2, limit)?;
        if self.search(Kind::Space, close + 2, end).is_some() {
            return None;
        }
        let url = self.line.u.get(close + 2..end)?;
        if link_scheme_len(url).is_none_or(|n| url.len() <= n) || !self.room(1) {
            return None;
        }
        let link = Link {
            label: text(self.line.u.get(p + 1..close)?),
            target: LinkTarget::Url(text(url)),
        };
        self.push(p, end + 1, SpanStyle::Link, Some(link));
        Some(end + 1)
    }

    /// A bare `http(s)://` URL up to whitespace, minus trailing punctuation,
    /// trailing emphasis marks (`*`, `_`, `~`: the closer of a styled URL) and
    /// an unbalanced `)`.
    fn url(&mut self, p: usize) -> Option<usize> {
        let rest = self.line.u.get(p..self.line.hi)?;
        let scheme = ["https://", "http://"]
            .into_iter()
            .find(|s| starts_with_ci(rest, s))?
            .len();
        if is_alnum(self.line.before(p)) {
            return None;
        }
        let (mut opens, mut closes) = (0_usize, 0_usize);
        let mut end = p + scheme;
        while let Some(c) = self.line.at(end).filter(|&c| !is_space(Some(c))) {
            opens += usize::from(c == LPAREN);
            closes += usize::from(c == RPAREN);
            end += 1;
        }
        self.out.work += end - p;
        let trim = b".,;:!?'\"*_~";
        while end > p + scheme {
            let last = self.line.at(end - 1)?;
            if trim.iter().any(|&b| u16::from(b) == last) {
                end -= 1;
            } else if last == RPAREN && closes > opens {
                closes -= 1;
                end -= 1;
            } else {
                break;
            }
        }
        if end <= p + scheme || !self.room(1) {
            return None;
        }
        let url = text(self.line.u.get(p..end)?);
        let link = Link {
            label: url.clone(),
            target: LinkTarget::Url(url),
        };
        self.push(p, end, SpanStyle::Link, Some(link));
        Some(end)
    }

    /// `*`, `_` and `~` at `p`: a closer waiting here closes, otherwise an
    /// opener with a findable closer waits. Returns where the scan resumes.
    fn delim(&mut self, p: usize, c: u16) -> usize {
        self.pending.retain(|x| x.close >= p);
        if let Some(i) = self.pending.iter().position(|x| x.close == p) {
            let x = self.pending.remove(i);
            if self.room(3) {
                self.push(x.open, x.open + x.len, SpanStyle::Syntax, None);
                self.push(x.open + x.len, x.close, x.style, None);
                self.push(x.close, x.close + x.len, SpanStyle::Syntax, None);
            }
            return x.close + x.len;
        }
        let pair = self.line.at(p + 1) == Some(c);
        self.out.work += 1;
        let (style, kind, len) = match (c, pair) {
            (STAR, true) => (SpanStyle::Strong, Kind::StrongStar, 2),
            (STAR, false) => (SpanStyle::Emphasis, Kind::EmphStar, 1),
            (UNDER, true) => (SpanStyle::Strong, Kind::StrongUnder, 2),
            (UNDER, false) => (SpanStyle::Emphasis, Kind::EmphUnder, 1),
            (_, true) => (SpanStyle::Strike, Kind::Strike, 2),
            (_, false) => return p + 1,
        };
        let after = p + len;
        let inner = self.line.at(after);
        let word_ok = c != UNDER || !is_alnum(self.line.before(p));
        if inner.is_none() || is_space(inner) || !word_ok || self.pending.len() >= MAX_PENDING {
            return after;
        }
        let limit = self.limit(p);
        match self.search(kind, after + 1, limit) {
            Some(close) if !self.pending.iter().any(|x| x.close == close) => {
                self.pending.push(Pending {
                    open: p,
                    len,
                    close,
                    style,
                });
            }
            _ => {}
        }
        after
    }
}

// ----------------------------------------------------------------- parse

/// Parse `body` into blocks and spans. Total: any input yields a [`Rich`].
pub(crate) fn parse(body: &str) -> Rich {
    let length = utf16_len(body);
    let mut units: Vec<u16> = body.encode_utf16().take(MAX_UTF16 + 1).collect();
    let mut out = Out::default();
    let mut blocks = Vec::new();
    if units.len() > MAX_UTF16 {
        out.truncated = true;
        units.truncate(MAX_UTF16);
        // Only whole lines: stop at the last line that ENDS inside the window.
        let last_line_end = units.iter().rposition(|&c| c == LF).unwrap_or(0);
        units.truncate(last_line_end);
    }
    out.work += units.len();
    let mut start = 0;
    while start < units.len() {
        let raw_end = units
            .get(start..)
            .and_then(|rest| rest.iter().position(|&c| c == LF))
            .map_or(units.len(), |k| start + k);
        out.work += raw_end - start + 1;
        let crlf = raw_end > start && units.get(raw_end - 1) == Some(&CR);
        let end = if crlf { raw_end - 1 } else { raw_end };
        if let Some(block) = classify(&units, start, end) {
            if blocks.len() >= MAX_BLOCKS {
                out.truncated = true;
                break;
            }
            if out.spans.len() < MAX_SPANS && block.content.start < block.content.end {
                let line = Line {
                    u: &units,
                    lo: to_index(block.content.start),
                    hi: end,
                };
                Inline {
                    line,
                    finders: [Finder::default(); KINDS],
                    pending: Vec::new(),
                    out: &mut out,
                }
                .run();
            }
            blocks.push(block);
        }
        start = raw_end + 1;
    }
    out.spans.sort_by_key(|s| s.range.start);
    Rich {
        blocks,
        spans: out.spans,
        truncated: out.truncated,
        wiki_titles: out.titles,
        length,
        work: out.work,
    }
}

// ----------------------------------------------------------------- edits

fn units_of(body: &str) -> Vec<u16> {
    body.encode_utf16().collect()
}

/// The line holding `at`: `(start, end without terminator, ends CRLF)`.
fn line_at(u: &[u16], at: usize) -> (usize, usize, bool) {
    let at = at.min(u.len());
    let start = u
        .get(..at)
        .and_then(|head| head.iter().rposition(|&c| c == LF))
        .map_or(0, |i| i + 1);
    let raw_end = u
        .get(at..)
        .and_then(|tail| tail.iter().position(|&c| c == LF))
        .map_or(u.len(), |k| at + k);
    let cr = raw_end > start && u.get(raw_end - 1) == Some(&CR);
    let crlf = cr && raw_end < u.len();
    (start, if cr { raw_end - 1 } else { raw_end }, crlf)
}

pub(crate) struct Toggled {
    pub body: String,
    pub checked: bool,
    pub marker: Range,
}

/// Flip the checklist item on the line holding `at` (any UTF-16 offset on
/// it). ONLY the one unit inside the brackets changes, so everything else,
/// CRLF included, is byte-identical. A checked item is written back as a
/// lowercase `x`: `[X]` toggles to `[ ]` and back to `[x]`. `None` when that
/// line is not a checklist item.
pub(crate) fn toggle(body: &str, at: u32) -> Option<Toggled> {
    let mut u = units_of(body);
    let (start, end, _) = line_at(&u, to_index(at));
    let block = classify(&u, start, end)?;
    let marker = block
        .marker
        .filter(|_| block.kind == BlockKind::Checklist)?;
    let slot = u.get_mut(to_index(marker.start) + 1)?;
    *slot = if block.checked { SP } else { LOWER_X };
    Some(Toggled {
        body: text(&u),
        checked: !block.checked,
        marker,
    })
}

pub(crate) struct Returned {
    pub body: String,
    pub caret: u32,
}

/// The member pressed Return with the caret at `caret` (UTF-16; clamped to
/// the length and moved off a surrogate pair's middle).
///
/// - After the marker of a checklist or bullet item with content: a new
///   item continues on the next line (the line's own terminator, the same
///   indent and bullet, `[ ] ` for a checklist, n+1 for a numbered item) and
///   the text after the caret moves onto it.
/// - After the marker of an item with NO content: the list ENDS; the line
///   becomes empty and no newline is inserted.
/// - Anywhere else: a plain line terminator.
pub(crate) fn return_at(body: &str, caret: u32) -> Returned {
    let u = units_of(body);
    let mut caret = to_index(caret).min(u.len());
    if caret > 0 && caret < u.len() && is_low(u[caret]) && is_high(u[caret - 1]) {
        caret -= 1;
    }
    let (start, end, crlf) = line_at(&u, caret);
    // A caret between the CR and LF of a CRLF belongs to the line's end.
    let caret = caret.min(end);
    let term: &[u16] = if crlf { &[CR, LF] } else { &[LF] };
    let splice = |at: usize, cut: usize, put: &[u16]| {
        let mut next = u[..at].to_vec();
        next.extend_from_slice(put);
        next.extend_from_slice(&u[cut..]);
        text(&next)
    };

    let item = classify(&u, start, end)
        .filter(|b| matches!(b.kind, BlockKind::Checklist | BlockKind::Bullet))
        .and_then(|b| b.marker.map(|m| (b, m)))
        .filter(|(_, m)| caret >= to_index(m.end));
    let Some((block, marker)) = item else {
        return Returned {
            body: splice(caret, caret, term),
            caret: to_u32(caret + term.len()),
        };
    };

    let content = &u[to_index(block.content.start)..to_index(block.content.end)];
    if content.iter().all(|&c| is_space(Some(c))) {
        return Returned {
            body: splice(start, end, &[]),
            caret: to_u32(start),
        };
    }

    let indent = u[start..end]
        .iter()
        .take_while(|&&c| c == SP || c == TAB)
        .count();
    let mut put = term.to_vec();
    put.extend_from_slice(&u[start..start + indent]);
    let (m_start, m_end) = (to_index(marker.start), to_index(marker.end));
    if block.kind == BlockKind::Checklist {
        put.push(u[start + indent]);
        put.extend(" [ ] ".encode_utf16());
    } else if is_digit(u.get(m_start).copied()) {
        let n = text(&u[m_start..m_end - 1]).parse::<u64>().unwrap_or(0);
        put.extend((n.saturating_add(1)).to_string().encode_utf16());
        put.push(u[m_end - 1]);
        put.push(SP);
    } else {
        put.push(u[m_start]);
        put.push(SP);
    }
    Returned {
        body: splice(caret, caret, &put),
        caret: to_u32(caret + put.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bound by construction: `work <= WORK_FACTOR * length + SLACK`.
    const WORK_FACTOR: usize = 16;
    const SLACK: usize = 16;

    fn units(body: &str) -> Vec<u16> {
        body.encode_utf16().collect()
    }

    fn slice(body: &str, r: Range) -> String {
        text(&units(body)[to_index(r.start)..to_index(r.end)])
    }

    /// The UTF-16 offset of the first `needle` in `body`.
    fn at(body: &str, needle: &str) -> u32 {
        let i = body.find(needle).expect("the needle is in the body");
        utf16_len(&body[..i])
    }

    fn only_block(body: &str) -> Block {
        let rich = parse(body);
        assert_eq!(rich.blocks.len(), 1, "{body:?}");
        rich.blocks[0].clone()
    }

    fn spans(body: &str) -> Vec<(SpanStyle, String)> {
        parse(body)
            .spans
            .iter()
            .map(|s| (s.style, slice(body, s.range)))
            .collect()
    }

    fn assert_bounded(body: &str) -> Rich {
        let rich = parse(body);
        let limit = WORK_FACTOR * to_index(rich.length) + SLACK;
        assert!(
            rich.work <= limit,
            "work {} > {limit} for {body:?}",
            rich.work
        );
        rich
    }

    #[test]
    fn headings_one_to_six_are_headings_with_their_hashes_as_the_marker() {
        for level in 1..=6_usize {
            let body = format!("{} Title", "#".repeat(level));
            let b = only_block(&body);
            assert_eq!(b.kind, BlockKind::Heading, "{body}");
            assert_eq!(b.level, to_u32(level));
            assert_eq!(b.marker, Some(Range::of(0, level)));
            assert_eq!(slice(&body, b.content), "Title");
        }
    }

    #[test]
    fn seven_hashes_and_a_hash_without_a_space_are_paragraphs() {
        for body in ["####### x", "#nospace", "#"] {
            let b = only_block(body);
            let want = if body == "#" {
                BlockKind::Heading
            } else {
                BlockKind::Paragraph
            };
            assert_eq!(b.kind, want, "{body}");
        }
        let empty = only_block("##");
        assert_eq!((empty.kind, empty.level), (BlockKind::Heading, 2));
        assert_eq!(empty.content, Range::of(2, 2));
    }

    #[test]
    fn a_checklist_marker_is_the_three_bracket_units() {
        let cases = [
            ("- [ ] milk", false),
            ("* [x] milk", true),
            ("+ [X] milk", true),
        ];
        for (body, checked) in cases {
            let b = only_block(body);
            assert_eq!(b.kind, BlockKind::Checklist, "{body}");
            assert_eq!(b.checked, checked, "{body}");
            assert_eq!(b.marker, Some(Range::of(2, 5)));
            assert_eq!(slice(body, b.content), "milk");
        }
    }

    #[test]
    fn a_checklist_with_no_content_is_still_a_checklist() {
        for body in ["- [ ]", "- [ ] "] {
            let b = only_block(body);
            assert_eq!(b.kind, BlockKind::Checklist, "{body:?}");
            assert!(b.content.start == b.content.end);
            assert_eq!(b.content.end, utf16_len(body));
        }
    }

    #[test]
    fn brackets_glued_to_the_dash_or_to_text_are_not_a_checklist() {
        assert_eq!(only_block("-[ ] x").kind, BlockKind::Paragraph);
        let b = only_block("- [ ]x");
        assert_eq!(b.kind, BlockKind::Bullet);
        assert_eq!(slice("- [ ]x", b.content), "[ ]x");
        assert_eq!(only_block("- [] x").kind, BlockKind::Bullet);
    }

    #[test]
    fn a_checklist_after_an_emoji_is_not_a_checklist() {
        assert_eq!(only_block("😀 - [ ]").kind, BlockKind::Paragraph);
    }

    #[test]
    fn indent_levels_count_a_tab_or_two_spaces_as_one() {
        let body = "- [ ] a\n  - [ ] b\n    - [ ] c\n\t- [ ] d\n\t\t- [x] e\n   - f";
        let levels: Vec<u32> = parse(body).blocks.iter().map(|b| b.level).collect();
        assert_eq!(levels, [0, 1, 2, 1, 2, 1]);
        let rich = parse(body);
        let c = &rich.blocks[2];
        assert_eq!(
            c.marker,
            Some(Range::of(
                at(body, "c") as usize - 4,
                at(body, "c") as usize - 1
            ))
        );
        assert_eq!(slice(body, c.content), "c");
    }

    #[test]
    fn bullets_and_numbered_items_are_bullets() {
        let body = "- a\n* b\n+ c\n1. d\n10) e\n  2. f";
        let rich = parse(body);
        assert!(rich.blocks.iter().all(|b| b.kind == BlockKind::Bullet));
        let markers: Vec<String> = rich
            .blocks
            .iter()
            .map(|b| slice(body, b.marker.expect("a bullet has a marker")))
            .collect();
        assert_eq!(markers, ["-", "*", "+", "1.", "10)", "2."]);
        let contents: Vec<String> = rich.blocks.iter().map(|b| slice(body, b.content)).collect();
        assert_eq!(contents, ["a", "b", "c", "d", "e", "f"]);
        assert_eq!(rich.blocks[5].level, 1);
    }

    #[test]
    fn a_dash_alone_or_a_number_without_a_space_is_a_paragraph() {
        for body in ["-", "-x", "1.x", "1 x", "12345678901. x"] {
            assert_eq!(only_block(body).kind, BlockKind::Paragraph, "{body}");
        }
    }

    #[test]
    fn a_quote_has_its_marker_and_content_after_one_space() {
        let b = only_block("> said");
        assert_eq!(b.kind, BlockKind::Quote);
        assert_eq!(b.marker, Some(Range::of(0, 1)));
        assert_eq!(b.content, Range::of(2, 6));
        assert_eq!(only_block(">x").content, Range::of(1, 2));
    }

    #[test]
    fn a_paragraph_content_skips_its_indent() {
        let b = only_block("   plain");
        assert_eq!(b.kind, BlockKind::Paragraph);
        assert_eq!(
            (b.range, b.content, b.marker),
            (Range::of(0, 8), Range::of(3, 8), None)
        );
    }

    #[test]
    fn blank_lines_make_no_block_and_lines_keep_their_ranges() {
        let body = "a\n\n  \nb\n";
        let rich = parse(body);
        let ranges: Vec<Range> = rich.blocks.iter().map(|b| b.range).collect();
        assert_eq!(ranges, [Range::of(0, 1), Range::of(6, 7)]);
        assert!(parse("").blocks.is_empty());
        assert_eq!(parse("").length, 0);
    }

    #[test]
    fn crlf_lines_exclude_the_carriage_return_from_every_range() {
        let body = "# Hi\r\n- [x] a **b**\r\nlast";
        let rich = parse(body);
        let ranges: Vec<Range> = rich.blocks.iter().map(|b| b.range).collect();
        assert_eq!(
            ranges,
            [Range::of(0, 4), Range::of(6, 19), Range::of(21, 25)]
        );
        assert_eq!(slice(body, rich.blocks[1].content), "a **b**");
        assert!(rich.spans.iter().all(|s| slice(body, s.range) != "\r"));
        assert_eq!(rich.length, 25);
    }

    #[test]
    fn a_wiki_link_after_an_emoji_has_exact_utf16_offsets() {
        let body = "- [ ] 😀 [[A]]";
        let rich = parse(body);
        assert_eq!(rich.length, 14);
        assert_eq!(rich.blocks[0].content, Range::of(6, 14));
        assert_eq!(rich.spans.len(), 1);
        assert_eq!(rich.spans[0].range, Range::of(9, 14));
        assert_eq!(rich.spans[0].style, SpanStyle::Link);
        assert_eq!(rich.wiki_titles, ["A"]);
    }

    #[test]
    fn an_emoji_inside_a_link_label_and_title_counts_two_units() {
        let body = "x [😀 a](https://e.com) [[😀]]";
        let rich = parse(body);
        assert_eq!(rich.spans[0].range, Range::of(2, 23));
        assert_eq!(
            rich.spans[0].link,
            Some(Link {
                label: "😀 a".into(),
                target: LinkTarget::Url("https://e.com".into())
            })
        );
        assert_eq!(rich.spans[1].range, Range::of(24, 30));
        assert_eq!(rich.wiki_titles, ["😀"]);
    }

    #[test]
    fn a_link_inside_a_checklist_item_is_found_in_its_content() {
        let body = "  - [x] see [[Plan]] and https://a.io/x.";
        let rich = parse(body);
        let got: Vec<_> = rich
            .spans
            .iter()
            .map(|s| (s.style, slice(body, s.range)))
            .collect();
        assert_eq!(
            got,
            [
                (SpanStyle::Link, "[[Plan]]".to_owned()),
                (SpanStyle::Link, "https://a.io/x".to_owned())
            ]
        );
        assert_eq!(rich.blocks[0].level, 1);
    }

    #[test]
    fn a_markdown_link_carries_its_label_and_url() {
        let body = "go [docs](https://d.dev/a?b=1) now";
        let rich = parse(body);
        assert_eq!(rich.spans.len(), 1);
        let link = rich.spans[0].link.clone().expect("a link span has a link");
        assert_eq!(link.label, "docs");
        assert_eq!(link.target, LinkTarget::Url("https://d.dev/a?b=1".into()));
        assert_eq!(
            slice(body, rich.spans[0].range),
            "[docs](https://d.dev/a?b=1)"
        );
    }

    #[test]
    fn only_http_https_and_mailto_become_links_and_the_scheme_ignores_case() {
        for ok in [
            "[a](HTTP://x.io)",
            "[a](mailto:me@x.io)",
            "[a](https://x.io)",
        ] {
            assert_eq!(parse(ok).spans.len(), 1, "{ok}");
        }
        for bad in [
            "[a](javascript:alert(1))",
            "[a](JaVaScRiPt:alert)",
            "[a](data:text/html,x)",
            "[a](file:///etc/passwd)",
            "[a](ftp://x)",
            "[a](/relative)",
            "[a](https://)",
            "[a](mailto:x y)",
            "[](mailto:x)",
        ] {
            assert!(parse(bad).spans.is_empty(), "{bad}");
        }
    }

    #[test]
    fn a_bare_url_drops_trailing_punctuation_and_an_unbalanced_paren() {
        let cases = [
            ("see https://a.io/x.", "https://a.io/x"),
            ("see https://a.io/x?!", "https://a.io/x"),
            ("(https://a.io/x)", "https://a.io/x"),
            ("https://a.io/(b)", "https://a.io/(b)"),
            ("https://a.io/(b).", "https://a.io/(b)"),
            ("https://a.io/(b))", "https://a.io/(b)"),
            ("\"http://a.io\",", "http://a.io"),
            ("HTTPS://A.IO;", "HTTPS://A.IO"),
        ];
        for (body, want) in cases {
            let rich = parse(body);
            assert_eq!(rich.spans.len(), 1, "{body}");
            let link = rich.spans[0].link.clone().expect("a link span has a link");
            assert_eq!(link.label, want, "{body}");
            assert_eq!(link.target, LinkTarget::Url(want.to_owned()));
            assert_eq!(slice(body, rich.spans[0].range), want);
        }
    }

    #[test]
    fn a_styled_bare_url_keeps_its_closer_out_of_the_link() {
        for (body, style) in [
            ("**http://x.com**", SpanStyle::Strong),
            ("_http://x.com_", SpanStyle::Emphasis),
            ("~~http://x.com~~", SpanStyle::Strike),
        ] {
            let rich = parse(body);
            let styled = rich
                .spans
                .iter()
                .find(|span| span.style == style)
                .unwrap_or_else(|| panic!("{body}: no {style:?} span"));
            assert_eq!(slice(body, styled.range), "http://x.com", "{body}");
            let link = rich
                .spans
                .iter()
                .find_map(|span| span.link.clone())
                .expect("a link");
            assert_eq!(
                link.target,
                LinkTarget::Url("http://x.com".into()),
                "{body}"
            );
        }
        // A mark inside the URL stays; a mark before punctuation still goes.
        for (body, want) in [
            ("http://x.com/a_b", "http://x.com/a_b"),
            ("http://x.com*.", "http://x.com"),
        ] {
            let rich = parse(body);
            assert_eq!(rich.spans.len(), 1, "{body}");
            assert_eq!(slice(body, rich.spans[0].range), want, "{body}");
            assert_eq!(
                rich.spans[0].link.clone().expect("link").target,
                LinkTarget::Url(want.into()),
                "{body}"
            );
        }
    }

    #[test]
    fn a_bare_scheme_with_nothing_after_it_or_glued_to_a_word_is_plain() {
        for body in ["http://", "https://.", "xhttp://a.io", "http:/a.io"] {
            assert!(parse(body).spans.is_empty(), "{body}");
        }
    }

    #[test]
    fn unterminated_constructs_stay_plain() {
        for body in [
            "[[open",
            "[[open]",
            "[label](",
            "[label](mailto:a",
            "[label]",
            "**strong",
            "*em",
            "__x",
            "~~gone",
            "`code",
            "a ** b **",
            "a * b * c",
        ] {
            assert!(parse(body).spans.is_empty(), "{body}");
        }
    }

    #[test]
    fn empty_or_blank_wiki_brackets_are_not_links() {
        for body in ["[[]]", "[[ ]]", "[[   \t]]"] {
            let rich = parse(body);
            assert!(rich.spans.is_empty(), "{body}");
            assert!(rich.wiki_titles.is_empty());
        }
    }

    #[test]
    fn a_wiki_title_is_trimmed_in_the_label_and_the_target() {
        let rich = parse("[[  Hello world  ]]");
        assert_eq!(rich.spans[0].range, Range::of(0, 19));
        let link = rich.spans[0].link.clone().expect("a link span has a link");
        assert_eq!(link.label, "Hello world");
        assert_eq!(link.target, LinkTarget::Wiki("Hello world".into()));
        assert_eq!(rich.wiki_titles, ["Hello world"]);
    }

    #[test]
    fn nested_wiki_openers_link_the_innermost_pair() {
        let body = "[[a [[b]]";
        let rich = parse(body);
        assert_eq!(rich.spans.len(), 1);
        assert_eq!(slice(body, rich.spans[0].range), "[[b]]");
        assert_eq!(rich.wiki_titles, ["b"]);
        let triple = "[[[c]]";
        assert_eq!(spans(triple), [(SpanStyle::Link, "[[c]]".to_owned())]);
    }

    #[test]
    fn wiki_titles_are_distinct_in_first_seen_order() {
        let rich = parse("[[B]] [[A]] [[B]] [[ A ]] [[a]]");
        assert_eq!(rich.wiki_titles, ["B", "A", "a"]);
        assert_eq!(rich.spans.len(), 5);
    }

    #[test]
    fn wiki_titles_cap_at_thirty_two_while_every_link_stays_a_span() {
        let body: String = (0..40).map(|i| format!("[[t{i}]] ")).collect();
        let rich = parse(&body);
        assert_eq!(rich.wiki_titles.len(), MAX_WIKI_TITLES);
        assert_eq!(rich.wiki_titles[0], "t0");
        assert_eq!(rich.wiki_titles[31], "t31");
        assert_eq!(rich.spans.len(), 40);
        assert!(!rich.truncated);
    }

    #[test]
    fn a_code_span_hides_everything_inside_it() {
        let body = "`[[A]] **b** https://x.io` and [[C]]";
        let got = spans(body);
        assert_eq!(
            got,
            [
                (SpanStyle::Code, "`[[A]] **b** https://x.io`".to_owned()),
                (SpanStyle::Link, "[[C]]".to_owned())
            ]
        );
        assert_eq!(parse(body).wiki_titles, ["C"]);
        assert!(parse("``").spans.is_empty());
    }

    #[test]
    fn a_link_hides_the_emphasis_inside_its_label() {
        let got = spans("[**a**](https://x.io)");
        assert_eq!(got, [(SpanStyle::Link, "[**a**](https://x.io)".to_owned())]);
    }

    #[test]
    fn emphasis_strong_and_strike_cover_the_inner_text_with_syntax_on_both_sides() {
        let cases = [
            ("**b**", SpanStyle::Strong, "b", 2),
            ("__b__", SpanStyle::Strong, "b", 2),
            ("*e*", SpanStyle::Emphasis, "e", 1),
            ("_e_", SpanStyle::Emphasis, "e", 1),
            ("~~s~~", SpanStyle::Strike, "s", 2),
        ];
        for (body, style, inner, delim) in cases {
            let got = spans(body);
            let d = body[..delim].to_owned();
            assert_eq!(
                got,
                [
                    (SpanStyle::Syntax, d.clone()),
                    (style, inner.to_owned()),
                    (SpanStyle::Syntax, d)
                ],
                "{body}"
            );
        }
    }

    #[test]
    fn styles_nest_and_links_work_inside_them() {
        let body = "**see [[A]] and *x***";
        let rich = parse(body);
        let styles: Vec<SpanStyle> = rich.spans.iter().map(|s| s.style).collect();
        assert!(styles.contains(&SpanStyle::Strong));
        assert!(styles.contains(&SpanStyle::Link));
        assert!(
            rich.spans
                .windows(2)
                .all(|w| w[0].range.start <= w[1].range.start)
        );
        assert_eq!(rich.wiki_titles, ["A"]);
    }

    #[test]
    fn snake_case_and_spaced_stars_are_not_emphasis() {
        for body in [
            "snake_case_name",
            "a_b_c",
            "2 * 3 * 4",
            "a *b",
            "__init__.py x",
        ] {
            let plain = spans(body).iter().all(|(s, _)| *s != SpanStyle::Emphasis);
            assert!(plain, "{body}");
        }
        assert!(parse("snake_case_name").spans.is_empty());
        assert_eq!(
            spans("an _em_ here")[1],
            (SpanStyle::Emphasis, "em".to_owned())
        );
    }

    #[test]
    fn a_heading_or_list_marker_gets_no_syntax_span() {
        for body in ["# a", "- a", "* a", "> a", "- [ ] a", "1. a"] {
            assert!(parse(body).spans.is_empty(), "{body}");
        }
        let got = spans("# **a**");
        assert_eq!(got.len(), 3);
    }

    #[test]
    fn inline_never_crosses_a_line() {
        for body in ["**a\nb**", "[[a\nb]]", "`a\nb`", "[a](mailto:\nx)"] {
            assert!(parse(body).spans.is_empty(), "{body:?}");
        }
    }

    #[test]
    fn toggling_flips_only_the_bracket_unit_and_round_trips() {
        let body = "# T\n- [ ] a\n- [x] b\r\n- [X] c";
        let on = toggle(body, at(body, "a")).expect("a checklist line");
        assert!(on.checked);
        assert_eq!(on.body, "# T\n- [x] a\n- [x] b\r\n- [X] c");
        assert_eq!(on.marker, Range::of(6, 9));
        let off = toggle(&on.body, 7).expect("a checklist line");
        assert!(!off.checked);
        assert_eq!(off.body, body);
        let again = toggle(&off.body, 7).expect("a checklist line");
        assert_eq!(again.body, on.body);
    }

    #[test]
    fn an_uppercase_x_toggles_to_blank_and_back_to_lowercase() {
        let off = toggle("- [X] c", 0).expect("a checklist line");
        assert_eq!((off.body.as_str(), off.checked), ("- [ ] c", false));
        assert_eq!(
            toggle(&off.body, 0).expect("a checklist line").body,
            "- [x] c"
        );
    }

    #[test]
    fn toggling_works_from_the_line_start_middle_end_and_keeps_crlf() {
        let body = "a\r\n  - [ ] item 😀\r\nz";
        let start = 3;
        let end = at(body, "\r\nz");
        for caret in [start, start + 4, at(body, "item"), end - 1, end, end + 1] {
            let t = toggle(body, caret).unwrap_or_else(|| panic!("caret {caret}"));
            assert_eq!(t.body, "a\r\n  - [x] item 😀\r\nz", "caret {caret}");
            assert_eq!(t.marker, Range::of(7, 10));
        }
        assert!(toggle(body, 0).is_none());
        assert!(toggle(body, end + 2).is_none());
    }

    #[test]
    fn toggling_a_line_that_is_not_a_checklist_is_none() {
        let body = "- bullet\n[ ] bare\n# - [ ] h\n> - [ ] q\n";
        for caret in [0, 3, 9, 14, 20, 28, 99] {
            assert!(toggle(body, caret).is_none(), "caret {caret}");
        }
        assert!(toggle("", 0).is_none());
    }

    #[test]
    fn return_on_an_item_continues_the_list_after_the_caret() {
        let cases = [
            ("- [ ] milk", 10, "- [ ] milk\n- [ ] ", 17),
            ("- [x] milk", 10, "- [x] milk\n- [ ] ", 17),
            ("  * [ ] milk", 12, "  * [ ] milk\n  * [ ] ", 21),
            ("- milk", 6, "- milk\n- ", 9),
            ("\t+ milk", 7, "\t+ milk\n\t+ ", 11),
            ("1. milk", 7, "1. milk\n2. ", 11),
            ("9) milk", 7, "9) milk\n10) ", 12),
            ("- [ ] milk\nnext", 10, "- [ ] milk\n- [ ] \nnext", 17),
        ];
        for (body, caret, want, want_caret) in cases {
            let r = return_at(body, caret);
            assert_eq!(r.body, want, "{body:?}");
            assert_eq!(r.caret, want_caret, "{body:?}");
        }
    }

    #[test]
    fn return_in_the_middle_of_an_item_moves_the_tail_onto_the_new_item() {
        let r = return_at("- [ ] milk and eggs", 10);
        assert_eq!(r.body, "- [ ] milk\n- [ ]  and eggs");
        assert_eq!(r.caret, 17);
        let b = return_at("- [ ] 😀😀", 8);
        assert_eq!(b.body, "- [ ] 😀\n- [ ] 😀");
        assert_eq!(b.caret, 8 + 1 + 6);
    }

    #[test]
    fn return_uses_the_lines_own_terminator() {
        let r = return_at("- [ ] a\r\n- [ ] b", 7);
        assert_eq!(r.body, "- [ ] a\r\n- [ ] \r\n- [ ] b");
        assert_eq!(r.caret, 7 + 2 + 6);
        let lf = return_at("- [ ] a\n- [ ] b\r\nc", 7);
        assert_eq!(lf.body, "- [ ] a\n- [ ] \n- [ ] b\r\nc");
        let plain = return_at("abc\r\ndef", 1);
        assert_eq!(plain.body, "a\r\nbc\r\ndef");
        assert_eq!(plain.caret, 3);
    }

    #[test]
    fn return_on_an_empty_item_ends_the_list_without_a_newline() {
        let cases = [
            ("- [ ]", 5, "", 0),
            ("- [ ] ", 6, "", 0),
            ("a\n  - [ ]   \nb", 12, "a\n\nb", 2),
            ("- \nx", 2, "\nx", 0),
            ("1. ", 3, "", 0),
            ("- a\n- ", 6, "- a\n", 4),
            ("- a\r\n- [ ] \r\n", 11, "- a\r\n\r\n", 5),
        ];
        for (body, caret, want, want_caret) in cases {
            let r = return_at(body, caret);
            assert_eq!(r.body, want, "{body:?}");
            assert_eq!(r.caret, want_caret, "{body:?}");
        }
    }

    #[test]
    fn return_before_or_inside_the_marker_or_on_another_line_inserts_a_plain_newline() {
        let cases = [
            ("- [ ] milk", 0, "\n- [ ] milk", 1),
            ("- [ ] milk", 1, "-\n [ ] milk", 2),
            ("- [ ] milk", 3, "- [\n ] milk", 4),
            ("- [ ] milk", 4, "- [ \n] milk", 5),
            ("# Title", 7, "# Title\n", 8),
            ("plain text", 5, "plain\n text", 6),
            ("> quote", 7, "> quote\n", 8),
            ("", 0, "\n", 1),
            ("a\n", 2, "a\n\n", 3),
        ];
        for (body, caret, want, want_caret) in cases {
            let r = return_at(body, caret);
            assert_eq!(r.body, want, "{body:?} @{caret}");
            assert_eq!(r.caret, want_caret, "{body:?} @{caret}");
        }
    }

    #[test]
    fn return_clamps_the_caret_and_snaps_off_a_surrogate_pair() {
        let past = return_at("ab", 99);
        assert_eq!((past.body.as_str(), past.caret), ("ab\n", 3));
        let between = return_at("a😀b", 2);
        assert_eq!(between.body, "a\n😀b");
        assert_eq!(between.caret, 2);
        let after = return_at("a😀b", 3);
        assert_eq!(after.body, "a😀\nb");
        let crlf_gap = return_at("ab\r\ncd", 3);
        assert_eq!(crlf_gap.body, "ab\r\n\r\ncd");
        assert_eq!(crlf_gap.caret, 4);
    }

    #[test]
    fn a_huge_body_is_truncated_to_whole_lines_and_keeps_its_full_length() {
        let body = "word word word\n".repeat(70_000);
        assert!(body.len() > 1_000_000);
        let rich = assert_bounded(&body);
        assert!(rich.truncated);
        assert_eq!(rich.length, utf16_len(&body));
        assert!(rich.blocks.len() <= MAX_BLOCKS);
        assert!(rich.spans.len() <= MAX_SPANS);
        assert!(
            rich.blocks
                .iter()
                .all(|b| to_index(b.range.end) <= MAX_UTF16)
        );
    }

    #[test]
    fn a_body_over_the_window_with_no_newline_parses_nothing() {
        let body = "x".repeat(MAX_UTF16 + 5);
        let rich = assert_bounded(&body);
        assert!(rich.truncated && rich.blocks.is_empty());
        assert_eq!(to_index(rich.length), MAX_UTF16 + 5);
    }

    #[test]
    fn a_body_exactly_the_window_is_parsed_whole() {
        let body = format!("{}\n", "y".repeat(MAX_UTF16 - 1));
        let rich = parse(&body);
        assert!(!rich.truncated);
        assert_eq!(rich.blocks.len(), 1);
    }

    #[test]
    fn ten_thousand_checklist_lines_cap_at_the_block_limit() {
        let body = "- [ ] item\n".repeat(10_000);
        let rich = assert_bounded(&body);
        assert_eq!(rich.blocks.len(), MAX_BLOCKS);
        assert!(rich.truncated);
        assert_eq!(rich.length, utf16_len(&body));
    }

    #[test]
    fn spans_stop_at_the_span_limit_and_stay_sorted() {
        let body = "**a** **b** **c**\n".repeat(1_500);
        let rich = assert_bounded(&body);
        assert!(rich.truncated);
        assert!(rich.spans.len() <= MAX_SPANS);
        assert!(rich.spans.len() >= MAX_SPANS - 2);
        assert!(
            rich.spans
                .windows(2)
                .all(|w| w[0].range.start <= w[1].range.start)
        );
    }

    #[test]
    fn adversarial_lines_cost_a_constant_per_unit() {
        let n = 200_000;
        let bodies = [
            "*".repeat(n),
            "[".repeat(n),
            "[[".repeat(n / 2),
            "*_".repeat(n / 2),
            "_*".repeat(n / 2),
            "~".repeat(n),
            "`".repeat(n),
            "[a](".repeat(n / 4),
            "](".repeat(n / 2),
            "[[a ".repeat(n / 4),
            "**a ".repeat(n / 4),
            "http://".repeat(n / 7),
            "(".repeat(n),
            format!("http://x{}", ")".repeat(n)),
            format!("[{}](https://x.io)", "[".repeat(n)),
        ];
        for body in &bodies {
            let rich = assert_bounded(body);
            assert!(rich.spans.len() <= MAX_SPANS);
            assert_eq!(to_index(rich.length), body.encode_utf16().count());
        }
    }

    #[test]
    fn many_short_adversarial_lines_stay_bounded_too() {
        let body = "[[a **b *c _d ~~e `f\n".repeat(5_000);
        assert_bounded(&body);
        let mixed = "- [ ] [[x]] **y** https://z.io/(a). `c`\n".repeat(3_000);
        assert_bounded(&mixed);
    }

    /// A tiny deterministic generator: no clock, no dependency.
    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self, below: usize) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            usize::try_from(self.0 >> 33).unwrap_or(0) % below
        }
    }

    #[test]
    fn generated_bodies_keep_every_range_in_bounds_ordered_and_whole() {
        const PIECES: [&str; 32] = [
            "*",
            "**",
            "_",
            "__",
            "~~",
            "`",
            "[",
            "]",
            "(",
            ")",
            "[[",
            "]]",
            "- ",
            "- [ ] ",
            "* [x] ",
            "1. ",
            "# ",
            "> ",
            "\n",
            "\r\n",
            "\n",
            "😀",
            "a",
            "word ",
            "http://x.io/a.",
            " ",
            "\t",
            "https://e.com/(a)",
            "[l](https://u.io)",
            "[[T]]",
            "é",
            "ab_cd ",
        ];
        let mut rng = Lcg(7);
        for round in 0..400 {
            let body: String = (0..rng.next(60))
                .map(|_| PIECES[rng.next(PIECES.len())])
                .collect();
            let rich = assert_bounded(&body);
            let u = units(&body);
            let len = u.len();
            assert_eq!(to_index(rich.length), len);
            let whole = |r: Range| {
                let (s, e) = (to_index(r.start), to_index(r.end));
                assert!(s <= e && e <= len, "round {round} {body:?} {r:?}");
                assert!(
                    !(s > 0 && s < len && is_low(u[s]) && is_high(u[s - 1])),
                    "split at {s} in {body:?}"
                );
                assert!(
                    !(e > 0 && e < len && is_low(u[e]) && is_high(u[e - 1])),
                    "split at {e} in {body:?}"
                );
            };
            let mut last_line_end = 0;
            for b in &rich.blocks {
                whole(b.range);
                whole(b.content);
                b.marker.into_iter().for_each(whole);
                assert!(b.range.start <= b.content.start && b.content.end == b.range.end);
                assert!(to_index(b.range.start) >= last_line_end, "{body:?}");
                last_line_end = to_index(b.range.end);
                assert!(!slice(&body, b.range).contains('\n'));
                assert!(!slice(&body, b.range).ends_with('\r'));
            }
            for s in &rich.spans {
                whole(s.range);
                assert!(s.range.start < s.range.end);
                assert_eq!(s.link.is_some(), s.style == SpanStyle::Link);
            }
            assert!(
                rich.spans
                    .windows(2)
                    .all(|w| w[0].range.start <= w[1].range.start)
            );
            assert!(rich.wiki_titles.len() <= MAX_WIKI_TITLES);

            for caret in [0, 1, 2, 5, 9, 17, 40, 1_000] {
                let r = return_at(&body, caret);
                assert!(
                    to_index(r.caret) <= units(&r.body).len(),
                    "{body:?} @{caret}"
                );
                if let Some(t) = toggle(&body, caret) {
                    assert_eq!(utf16_len(&t.body), rich.length);
                    assert_eq!(toggle(&t.body, caret).map(|x| x.checked), Some(!t.checked));
                }
            }
        }
    }
}
