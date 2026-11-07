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
//! length + SLACK` (`WORK_FACTOR` is 8, see the tests).
//!
//! Choices the grammar left open:
//! - Nested wiki openers: the INNERMOST valid pair wins. A `[[` whose title
//!   would contain another `[` is not a link; the scan moves on and the inner
//!   `[[b]]` is.
//! - A markdown link's URL ends at the FIRST `)` (so `(a(b))` is cut short),
//!   may not contain whitespace, and its label may not contain `[`.
//! - A bare URL runs to whitespace, so `**http://x**` swallows the closing
//!   `**` (that emphasis stays plain). `***x***` is not specially handled.
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
        if self.line.at(p + 1) == Some(LBRACKET) {
            if let Some(next) = self.wiki(p, limit) {
                return Some(next);
            }
        }
        self.markdown_link(p, limit)
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

    /// A bare `http(s)://` URL up to whitespace, minus trailing punctuation
    /// and an unbalanced `)`.
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
        let trim = b".,;:!?'\"";
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
