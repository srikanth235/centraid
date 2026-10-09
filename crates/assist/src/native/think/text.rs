//! The text helpers of the think rewrite: the words of a message and of a row's name, whether two of them read as the same word,
//! and whether a message talks about time. They are what `pick_reason` reads (`think.rs`); they were `authored/trace.py`'s
//! `fold`, `toks`, `same`, `stem` and `date_clusters`, and the Python they replaced stays the oracle (`compile_oracle.py`).

use std::collections::HashMap;
use std::sync::OnceLock;

/// A character of a word: what Python's `\w` matches.
pub(super) fn is_word(letter: char) -> bool {
    letter.is_alphanumeric() || letter == '_'
}

/// Python's `str.isspace`: Unicode white space and the four information separators.
pub(super) fn is_space(letter: char) -> bool {
    letter.is_whitespace() || matches!(letter, '\u{1c}'..='\u{1f}')
}

/// `str.strip()`.
pub(super) fn py_strip(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `str.rstrip()`.
pub(super) fn py_rstrip(text: &str) -> &str {
    text.trim_end_matches(is_space)
}

/// `str.split()`: the words between runs of white space.
pub(super) fn py_split_ws(text: &str) -> Vec<&str> {
    text.split(is_space)
        .filter(|word| !word.is_empty())
        .collect()
}

/// The accents and compatibility forms Unicode's NFKD takes off a lower-case letter, one `letter` + what it folds to per line:
/// Latin, Greek and Cyrillic letters, ligatures, full-width forms, super and subscripts. Generated from `unicodedata` over
/// those blocks; a letter outside them folds to itself.
const FOLDS: &str = "ªa
²2
³3
µμ
¹1
ºo
¼1⁄4
½1⁄2
¾3⁄4
àa
áa
âa
ãa
äa
åa
çc
èe
ée
êe
ëe
ìi
íi
îi
ïi
ñn
òo
óo
ôo
õo
öo
ùu
úu
ûu
üu
ýy
ÿy
āa
ăa
ąa
ćc
ĉc
ċc
čc
ďd
ēe
ĕe
ėe
ęe
ěe
ĝg
ğg
ġg
ģg
ĥh
ĩi
īi
ĭi
įi
ĳij
ĵj
ķk
ĺl
ļl
ľl
ŀl·
ńn
ņn
ňn
ŉʼn
ōo
ŏo
őo
ŕr
ŗr
řr
śs
ŝs
şs
šs
ţt
ťt
ũu
ūu
ŭu
ůu
űu
ųu
ŵw
ŷy
źz
żz
žz
ſs
ơo
ưu
ǆdz
ǉlj
ǌnj
ǎa
ǐi
ǒo
ǔu
ǖu
ǘu
ǚu
ǜu
ǟa
ǡa
ǣæ
ǧg
ǩk
ǫo
ǭo
ǯʒ
ǰj
ǳdz
ǵg
ǹn
ǻa
ǽæ
ǿø
ȁa
ȃa
ȅe
ȇe
ȉi
ȋi
ȍo
ȏo
ȑr
ȓr
ȕu
ȗu
șs
țt
ȟh
ȧa
ȩe
ȫo
ȭo
ȯo
ȱo
ȳy
ʹʹ
ͺ 
ΐι
άα
έε
ήη
ίι
ΰυ
ϊι
ϋυ
όο
ύυ
ώω
ϐβ
ϑθ
ϒΥ
ϓΥ
ϔΥ
ϕφ
ϖπ
ϰκ
ϱρ
ϲς
ϵε
йи
ѐе
ёе
ѓг
їі
ќк
ѝи
ўу
ѷѵ
ӂж
ӑа
ӓа
ӗе
ӛә
ӝж
ӟз
ӣи
ӥи
ӧо
ӫө
ӭэ
ӯу
ӱу
ӳу
ӵч
ӹы
ḁa
ḃb
ḅb
ḇb
ḉc
ḋd
ḍd
ḏd
ḑd
ḓd
ḕe
ḗe
ḙe
ḛe
ḝe
ḟf
ḡg
ḣh
ḥh
ḧh
ḩh
ḫh
ḭi
ḯi
ḱk
ḳk
ḵk
ḷl
ḹl
ḻl
ḽl
ḿm
ṁm
ṃm
ṅn
ṇn
ṉn
ṋn
ṍo
ṏo
ṑo
ṓo
ṕp
ṗp
ṙr
ṛr
ṝr
ṟr
ṡs
ṣs
ṥs
ṧs
ṩs
ṫt
ṭt
ṯt
ṱt
ṳu
ṵu
ṷu
ṹu
ṻu
ṽv
ṿv
ẁw
ẃw
ẅw
ẇw
ẉw
ẋx
ẍx
ẏy
ẑz
ẓz
ẕz
ẖh
ẗt
ẘw
ẙy
ẚaʾ
ẛs
ạa
ảa
ấa
ầa
ẩa
ẫa
ậa
ắa
ằa
ẳa
ẵa
ặa
ẹe
ẻe
ẽe
ếe
ềe
ểe
ễe
ệe
ỉi
ịi
ọo
ỏo
ốo
ồo
ổo
ỗo
ộo
ớo
ờo
ởo
ỡo
ợo
ụu
ủu
ứu
ừu
ửu
ữu
ựu
ỳy
ỵy
ỷy
ỹy
⁰0
ⁱi
⁴4
⁵5
⁶6
⁷7
⁸8
⁹9
ⁿn
₀0
₁1
₂2
₃3
₄4
₅5
₆6
₇7
₈8
₉9
ₐa
ₑe
ₒo
ₓx
ₔə
ₕh
ₖk
ₗl
ₘm
ₙn
ₚp
ₛs
ₜt
⅐1⁄7
⅑1⁄9
⅒1⁄10
⅓1⁄3
⅔2⁄3
⅕1⁄5
⅖2⁄5
⅗3⁄5
⅘4⁄5
⅙1⁄6
⅚5⁄6
⅛1⁄8
⅜3⁄8
⅝5⁄8
⅞7⁄8
⅟1⁄
ⅰi
ⅱii
ⅲiii
ⅳiv
ⅴv
ⅵvi
ⅶvii
ⅷviii
ⅸix
ⅹx
ⅺxi
ⅻxii
ⅼl
ⅽc
ⅾd
ⅿm
↉0⁄3
①1
②2
③3
④4
⑤5
⑥6
⑦7
⑧8
⑨9
⑩10
⑪11
⑫12
⑬13
⑭14
⑮15
⑯16
⑰17
⑱18
⑲19
⑳20
⑴(1)
⑵(2)
⑶(3)
⑷(4)
⑸(5)
⑹(6)
⑺(7)
⑻(8)
⑼(9)
⑽(10)
⑾(11)
⑿(12)
⒀(13)
⒁(14)
⒂(15)
⒃(16)
⒄(17)
⒅(18)
⒆(19)
⒇(20)
⒈1.
⒉2.
⒊3.
⒋4.
⒌5.
⒍6.
⒎7.
⒏8.
⒐9.
⒑10.
⒒11.
⒓12.
⒔13.
⒕14.
⒖15.
⒗16.
⒘17.
⒙18.
⒚19.
⒛20.
ﬀff
ﬁfi
ﬂfl
ﬃffi
ﬄffl
ﬅst
ﬆst
０0
１1
２2
３3
４4
５5
６6
７7
８8
９9
ａa
ｂb
ｃc
ｄd
ｅe
ｆf
ｇg
ｈh
ｉi
ｊj
ｋk
ｌl
ｍm
ｎn
ｏo
ｐp
ｑq
ｒr
ｓs
ｔt
ｕu
ｖv
ｗw
ｘx
ｙy
ｚz";

fn folded(letter: char) -> Option<&'static str> {
    static INDEX: OnceLock<HashMap<char, &'static str>> = OnceLock::new();
    INDEX
        .get_or_init(|| {
            FOLDS
                .split('\n')
                .filter_map(|line| {
                    let mut chars = line.chars();
                    let key = chars.next()?;
                    Some((key, chars.as_str()))
                })
                .collect()
        })
        .get(&letter)
        .copied()
}

/// A combining mark: the ones NFKD splits off (Python's `unicodedata.combining` is not zero).
fn combining(letter: char) -> bool {
    matches!(letter, '\u{300}'..='\u{36f}' | '\u{483}'..='\u{489}' | '\u{591}'..='\u{5bd}' | '\u{20d0}'..='\u{20ff}' | '\u{fe20}'..='\u{fe2f}')
}

/// `trace.py` `fold`: lower-cased, accents and compatibility forms taken off (`é` is `e`, `ø` stays `ø`: NFKD does not split it).
pub(super) fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for letter in text.to_lowercase().chars() {
        if combining(letter) {
            continue;
        }
        match folded(letter) {
            Some(plain) => out.push_str(plain),
            None => out.push(letter),
        }
    }
    out
}

/// `[^\W_]`: a character of a word that is not an underscore.
fn is_token(letter: char) -> bool {
    letter.is_alphanumeric()
}

/// `trace.py` `norm_words`: the folded words of a text. A possessive `s` after an apostrophe is no word of its own.
pub(super) fn words(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        if !is_token(chars[at]) {
            at += 1;
            continue;
        }
        let start = at;
        while at < chars.len() && is_token(chars[at]) {
            at += 1;
        }
        let word = fold(&chars[start..at].iter().collect::<String>());
        let possessive = word == "s" && start > 0 && matches!(chars[start - 1], '\'' | '\u{2019}');
        if !possessive {
            out.push(word);
        }
    }
    out
}

/// The words a pick's reason ignores when it asks whether a message names a row.
pub(super) fn is_stop(word: &str) -> bool {
    matches!(
        word,
        "the"
            | "a"
            | "an"
            | "of"
            | "to"
            | "and"
            | "for"
            | "in"
            | "on"
            | "at"
            | "my"
            | "our"
            | "with"
            | "from"
            | "is"
            | "it"
            | "s"
    )
}

fn length(word: &str) -> usize {
    word.chars().count()
}

fn stem(word: &str) -> String {
    let size = length(word);
    let cut = |count: usize| word.chars().take(size - count).collect::<String>();
    if word.ends_with("ies") && size > 4 {
        return cut(3) + "y";
    }
    if word.ends_with("es") && size > 4 {
        return cut(2);
    }
    if word.ends_with('s') && size > 3 {
        return cut(1);
    }
    word.to_owned()
}

/// Edit distance at most one: a typo.
fn lev1(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (mut a, mut b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    if a.len() == b.len() {
        let diff: Vec<usize> = (0..a.len()).filter(|&at| a[at] != b[at]).collect();
        return diff.len() == 1
            || (diff.len() == 2
                && diff[1] == diff[0] + 1
                && a[diff[0]] == b[diff[1]]
                && a[diff[1]] == b[diff[0]]);
    }
    if a.len() > b.len() {
        std::mem::swap(&mut a, &mut b);
    }
    let mut at = 0;
    while at < a.len() && a[at] == b[at] {
        at += 1;
    }
    a[at..] == b[at + 1..]
}

/// Two folded words that read as the same word: equal, the same stem, a typo, or a clipped form.
pub(super) fn same(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (stem_a, stem_b) = (stem(a), stem(b));
    if stem_a == stem_b {
        return true;
    }
    let shortest = length(a).min(length(b));
    if shortest >= 5 && lev1(&stem_a, &stem_b) {
        return true;
    }
    shortest >= 4 && (a.starts_with(b) || b.starts_with(a))
}

// ---------------------------------------------------------------------------------------------
// does a message talk about time
//
// `trace.py` `date_clusters(message)` is not empty exactly when one of its two patterns matches somewhere: `STRONG_DATE`
// (a weekday, a month, a clock, an ordinal, a span like "two weeks", ...) or `LOOSE_DATE` (a bare hour after "at", "half 4",
// "next", "since <word>", ...). Both are `\b(?:alternatives)\b`, so a match is a run that starts after a non-word character
// and ends before one. Nothing needs the stretches themselves: a pick's reason asks only whether there is one. The two
// patterns are written out as the runs they match, and `compile_oracle.py` compares the answer to Python's over every
// message of the train data.
// ---------------------------------------------------------------------------------------------

const WEEKDAYS: [&str; 18] = [
    "mon",
    "monday",
    "tue",
    "tues",
    "tuesday",
    "wed",
    "weds",
    "wednesday",
    "thu",
    "thur",
    "thurs",
    "thursday",
    "fri",
    "friday",
    "sat",
    "saturday",
    "sun",
    "sunday",
];
const MONTHS: [&str; 24] = [
    "jan",
    "january",
    "feb",
    "february",
    "mar",
    "march",
    "apr",
    "april",
    "may",
    "jun",
    "june",
    "jul",
    "july",
    "aug",
    "august",
    "sep",
    "sept",
    "september",
    "oct",
    "october",
    "nov",
    "november",
    "dec",
    "december",
];
const DAY_WORDS: [&str; 23] = [
    "today",
    "tonight",
    "tomorrow",
    "tmrw",
    "tmr",
    "yesterday",
    "weekend",
    "weekends",
    "weekday",
    "weekdays",
    "noon",
    "midnight",
    "lunch",
    "lunchtime",
    "morning",
    "afternoon",
    "evening",
    "night",
    "ago",
    "later",
    "earlier",
    "weekly",
    "daily",
];
const MORE_DAY_WORDS: [&str; 2] = ["monthly", "fortnight"];
const ORDINALS: [&str; 20] = [
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
    "sixth",
    "seventh",
    "eighth",
    "ninth",
    "tenth",
    "eleventh",
    "twelfth",
    "thirteenth",
    "fourteenth",
    "fifteenth",
    "sixteenth",
    "seventeenth",
    "eighteenth",
    "nineteenth",
    "twentieth",
];
const UNIT_ORDINALS: [&str; 9] = [
    "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth",
];
const NUMBER_WORDS: [&str; 22] = [
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "fifteen",
    "twenty",
    "thirty",
    "forty",
    "a couple of",
    "a",
    "an",
    "half a",
    "half an",
    "couple",
];
const UNITS: [&str; 18] = [
    "min", "mins", "minute", "minutes", "hour", "hours", "hr", "hrs", "day", "days", "week",
    "weeks", "month", "months", "year", "years", "night", "nights",
];
const SPAN_LEADS: [&str; 9] = [
    "this",
    "next",
    "last",
    "coming",
    "following",
    "previous",
    "every",
    "each",
    "past",
];
const AT_WORDS: [&str; 8] = ["at", "to", "till", "until", "by", "around", "for", "from"];
const LOOSE_PHRASES: [&str; 17] = [
    "next",
    "upcoming",
    "coming up",
    "soon",
    "still to come",
    "from now",
    "remaining",
    "left",
    "future",
    "so far",
    "yet",
    "already",
    "ahead",
    "outstanding",
    "overdue",
    "latest",
    "recent",
];
const SINCE_WORDS: [&str; 5] = ["since", "before", "after", "until", "till"];

struct Run<'a> {
    text: &'a [char],
}

impl Run<'_> {
    fn starts(&self, at: usize, word: &str) -> bool {
        let mut at = at;
        for letter in word.chars() {
            if self.text.get(at) != Some(&letter) {
                return false;
            }
            at += 1;
        }
        true
    }

    /// `\b` after a match that ends on a word character.
    fn ends_word(&self, at: usize) -> bool {
        self.text.get(at).is_none_or(|&next| !is_word(next))
    }

    fn word_at(&self, at: usize, word: &str) -> bool {
        self.starts(at, word) && self.ends_word(at + word.chars().count())
    }

    fn digits(&self, at: usize) -> usize {
        self.text[at.min(self.text.len())..]
            .iter()
            .take_while(|letter| letter.is_ascii_digit())
            .count()
    }

    fn spaces(&self, at: usize) -> usize {
        self.text[at.min(self.text.len())..]
            .iter()
            .take_while(|&&letter| is_space(letter))
            .count()
    }

    /// `\s+` then a unit, whole.
    fn then_unit(&self, at: usize) -> bool {
        let gap = self.spaces(at);
        gap > 0 && UNITS.iter().any(|unit| self.word_at(at + gap, unit))
    }

    /// `\d{1,2}` and the places it can end.
    fn one_or_two_digits(&self, at: usize) -> Vec<usize> {
        (1..=2.min(self.digits(at)))
            .map(|count| at + count)
            .collect()
    }

    /// `\d{1,2}(?::\d\d)?` and the places it can end.
    fn clock_ends(&self, at: usize) -> Vec<usize> {
        let mut ends = Vec::new();
        for end in self.one_or_two_digits(at) {
            ends.push(end);
            if self.text.get(end) == Some(&':') && self.digits(end + 1) >= 2 {
                ends.push(end + 3);
            }
        }
        ends
    }

    /// `STRONG_DATE` at `at` (which follows a non-word character).
    fn strong(&self, at: usize) -> bool {
        let lists: [&[&str]; 4] = [&WEEKDAYS, &MONTHS, &DAY_WORDS, &MORE_DAY_WORDS];
        if lists
            .iter()
            .any(|list| list.iter().any(|word| self.word_at(at, word)))
        {
            return true;
        }
        // an ordinal word, or `twenty-first`, `thirty first`
        if ORDINALS.iter().any(|word| self.word_at(at, word)) || self.word_at(at, "thirtieth") {
            return true;
        }
        for (tens, units) in [
            ("twenty", &UNIT_ORDINALS[..]),
            ("thirty", &UNIT_ORDINALS[..1]),
        ] {
            if self.starts(at, tens) {
                let joiner = at + tens.len();
                if matches!(self.text.get(joiner), Some('-' | ' '))
                    && units.iter().any(|unit| self.word_at(joiner + 1, unit))
                {
                    return true;
                }
            }
        }
        // 5pm, 5:30 am, 12:30, 5th
        for end in self.clock_ends(at) {
            let gap = self.spaces(end);
            if ["am", "pm"]
                .iter()
                .any(|meridiem| self.word_at(end + gap, meridiem))
            {
                return true;
            }
        }
        for end in self.one_or_two_digits(at) {
            if self.text.get(end) == Some(&':')
                && self.digits(end + 1) == 2
                && self.ends_word(end + 3)
            {
                return true;
            }
            if ["st", "nd", "rd", "th"]
                .iter()
                .any(|suffix| self.word_at(end, suffix))
            {
                return true;
            }
        }
        if self.word_at(at, "oclock") || self.word_at(at, "o'clock") {
            return true;
        }
        // a year
        if (self.starts(at, "19") || self.starts(at, "20"))
            && self.digits(at + 2) >= 2
            && self.ends_word(at + 4)
        {
            return true;
        }
        // a count of units: `3 weeks`, `a couple of days`
        let run = self.digits(at);
        if run > 0 && self.then_unit(at + run) {
            return true;
        }
        if NUMBER_WORDS
            .iter()
            .any(|word| self.starts(at, word) && self.then_unit(at + word.chars().count()))
        {
            return true;
        }
        SPAN_LEADS
            .iter()
            .chain(&["the"])
            .any(|lead| self.starts(at, lead) && self.then_unit(at + lead.len()))
    }

    /// The negative look-ahead of "at 7": not followed by a digit or a colon, nor by "people", "things", "items", "rows" or "of".
    fn bare_hour_ok(&self, end: usize) -> bool {
        if matches!(self.text.get(end), Some(next) if next.is_ascii_digit() || *next == ':') {
            return false;
        }
        let after = end + self.spaces(end);
        !["people", "things", "items", "rows", "of"]
            .iter()
            .any(|word| self.starts(after, word))
    }

    /// `LOOSE_DATE` at `at` (which follows a non-word character).
    fn loose(&self, at: usize) -> bool {
        for lead in AT_WORDS {
            if self.starts(at, lead) {
                let gap = self.spaces(at + lead.len());
                if gap > 0
                    && self
                        .clock_ends(at + lead.len() + gap)
                        .into_iter()
                        .any(|end| self.bare_hour_ok(end) && self.ends_word(end))
                {
                    return true;
                }
            }
        }
        if self.starts(at, "half") {
            let gap = self.spaces(at + 4);
            if gap > 0 {
                let mut starts = vec![at + 4 + gap];
                if self.starts(at + 4 + gap, "past") {
                    let more = self.spaces(at + 8 + gap);
                    if more > 0 {
                        starts.push(at + 8 + gap + more);
                    }
                }
                if starts.into_iter().any(|start| {
                    self.one_or_two_digits(start)
                        .into_iter()
                        .any(|end| self.ends_word(end))
                }) {
                    return true;
                }
            }
        }
        if self.starts(at, "quarter") {
            let gap = self.spaces(at + 7);
            for word in ["to", "past"] {
                if gap > 0 && self.starts(at + 7 + gap, word) {
                    let more = self.spaces(at + 7 + gap + word.len());
                    if more > 0
                        && self
                            .one_or_two_digits(at + 7 + gap + word.len() + more)
                            .into_iter()
                            .any(|end| self.ends_word(end))
                    {
                        return true;
                    }
                }
            }
        }
        if LOOSE_PHRASES.iter().any(|phrase| self.word_at(at, phrase))
            || self.word_at(at, "recently")
        {
            return true;
        }
        // `since the weekend`: the word after one of them, a run of letters
        for lead in SINCE_WORDS {
            if self.starts(at, lead) {
                let gap = self.spaces(at + lead.len());
                let start = at + lead.len() + gap;
                let letters = self.text[start.min(self.text.len())..]
                    .iter()
                    .take_while(|&&letter| {
                        is_word(letter) && letter != '_' && !letter.is_ascii_digit()
                    })
                    .count();
                if gap > 0 && letters > 0 && self.ends_word(start + letters) {
                    return true;
                }
            }
        }
        false
    }
}

/// Does the message hold a time phrase (`trace.py` `date_clusters(message)` is not empty)?
pub(super) fn has_time_phrase(message: &str) -> bool {
    // Python's `re.I` reads four non-ASCII letters as ASCII ones
    let text: Vec<char> = message
        .chars()
        .map(|letter| match letter {
            '\u{131}' | '\u{130}' => 'i',
            '\u{17f}' => 's',
            '\u{212a}' => 'k',
            other => other.to_ascii_lowercase(),
        })
        .collect();
    let run = Run { text: &text };
    (0..text.len())
        .any(|at| (at == 0 || !is_word(text[at - 1])) && (run.strong(at) || run.loose(at)))
}

/// The segments of a `focus:` line as (reason, rows): `created #n ...` is `created`, `asked: ...` is `asked`, and `acted #n ...`,
/// `@k: ...` and `earlier: ...` are `focus`. `focus` is the line after `focus: `.
pub(super) fn focus_sets(focus: &str) -> Vec<(&'static str, Vec<String>)> {
    let mut segments: Vec<&str> = Vec::new();
    let mut start = 0;
    let mut search = 0;
    while let Some(found) = focus[search..].find(" · ") {
        let cut = search + found;
        let rest = &focus[cut + " · ".len()..];
        let at_mark = rest.starts_with("created ")
            || rest.starts_with("acted ")
            || rest.starts_with("asked: ")
            || rest.starts_with("earlier: ")
            || at_handle(rest);
        if at_mark {
            segments.push(&focus[start..cut]);
            start = cut + " · ".len();
        }
        search = cut + " · ".len();
    }
    segments.push(&focus[start..]);
    segments
        .into_iter()
        .map(|segment| {
            let why = if segment.starts_with("created ") {
                "created"
            } else if segment.starts_with("asked: ") {
                "asked"
            } else {
                "focus"
            };
            (why, row_numbers(segment))
        })
        .collect()
}

/// `@\d+: `.
fn at_handle(text: &str) -> bool {
    let Some(rest) = text.strip_prefix('@') else {
        return false;
    };
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && rest[digits..].starts_with(": ")
}

/// The `#n` of a text, as the digits written (a leading zero dropped), each once.
pub(super) fn row_numbers(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find('#') {
        rest = &rest[at + 1..];
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            let number = normal_int(&digits);
            if !out.contains(&number) {
                out.push(number);
            }
        }
    }
    out
}

/// `str(int(digits))`: no leading zeros.
pub(super) fn normal_int(digits: &str) -> String {
    let trimmed = digits.trim_start_matches('0');
    if trimmed.is_empty() {
        "0".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// The part of a row's line that is about the row: a line may show several rows (the vault block, the focus line).
pub(super) fn own_text<'a>(number: &str, line: &'a str) -> &'a str {
    let rest = line
        .find(&format!("#{number} "))
        .map_or(line, |at| &line[at..]);
    let skip = rest.chars().next().map_or(0, char::len_utf8);
    // ` #\d+ ` after the first character
    let tail = &rest[skip..];
    let mut from = 0;
    while let Some(found) = tail[from..].find(" #") {
        let digits_at = from + found + 2;
        let digits = tail[digits_at..]
            .chars()
            .take_while(char::is_ascii_digit)
            .count();
        if digits > 0 && tail[digits_at + digits..].starts_with(' ') {
            return &rest[..skip + from + found];
        }
        from += found + 1;
    }
    rest
}

/// `\b\d{4}-\d\d-\d\d`: does the text show a date?
pub(super) fn shows_date(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let digit = |at: usize| chars.get(at).is_some_and(char::is_ascii_digit);
    (0..chars.len()).any(|at| {
        (at == 0 || !is_word(chars[at - 1]))
            && (0..4).all(|offset| digit(at + offset))
            && chars.get(at + 4) == Some(&'-')
            && digit(at + 5)
            && digit(at + 6)
            && chars.get(at + 7) == Some(&'-')
            && digit(at + 8)
            && digit(at + 9)
    })
}

/// The first nickname a row's text says (`nickname "Mo"`), without its quotes.
pub(super) fn nickname(text: &str) -> Option<&str> {
    let mut rest = text;
    while let Some(at) = rest.find("nickname \"") {
        let after = &rest[at + "nickname \"".len()..];
        if let Some(close) = after.find('"')
            && close > 0
        {
            return Some(&after[..close]);
        }
        rest = after;
    }
    None
}

/// Python's `repr` of a string: the quotes it picks and the escapes it writes.
pub(super) fn py_repr(text: &str) -> String {
    let quote = if text.contains('\'') && !text.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::from(quote);
    for letter in text.chars() {
        match letter {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other if other == quote => {
                out.push('\\');
                out.push(other);
            }
            other if is_printable(other) => out.push(other),
            other => {
                let code = u32::from(other);
                if code < 0x100 {
                    out.push_str(&format!("\\x{code:02x}"));
                } else if code < 0x10000 {
                    out.push_str(&format!("\\u{code:04x}"));
                } else {
                    out.push_str(&format!("\\U{code:08x}"));
                }
            }
        }
    }
    out.push(quote);
    out
}

/// Python's `str.isprintable` for one character, as far as the categories Rust can tell apart.
fn is_printable(letter: char) -> bool {
    if letter == ' ' {
        return true;
    }
    !(letter.is_control()
        || letter.is_whitespace()
        || matches!(letter, '\u{ad}' | '\u{600}'..='\u{605}' | '\u{61c}' | '\u{6dd}' | '\u{70f}' | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206f}' | '\u{feff}' | '\u{fff9}'..='\u{fffb}' | '\u{e000}'..='\u{f8ff}'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_word_folds_like_nfkd_without_its_marks() {
        assert_eq!(fold("Café"), "cafe");
        assert_eq!(fold("Tromsø"), "tromsø");
        assert_eq!(fold("ŁÓDŹ"), "łodz");
        assert_eq!(fold("ﬁne"), "fine");
        assert_eq!(fold("e\u{301}"), "e");
    }

    #[test]
    fn words_drop_a_possessive_s() {
        assert_eq!(words("Mo's café, 2 days"), ["mo", "cafe", "2", "days"]);
    }

    #[test]
    fn two_words_read_as_the_same_word() {
        assert!(same("rents", "rent"));
        assert!(same("aadhar", "aadhaar"));
        assert!(same("dentist", "dentis"));
        assert!(
            same("dental", "rental"),
            "one letter off in a long word is a typo"
        );
        assert!(!same("dental", "dentist"));
    }

    #[test]
    fn a_message_talks_about_time_or_does_not() {
        for yes in [
            "tick off the rent friday",
            "at 7",
            "move it to 7",
            "half 4",
            "quarter to 6",
            "12pm",
            "since the weekend",
            "two weeks ago",
            "the 3rd",
            "next one",
            "on 2026-03-01 2026",
            "meet at 5:30",
            "a couple of days",
            "twenty-first",
            "the week",
        ] {
            assert!(has_time_phrase(yes), "{yes}");
        }
        for no in [
            "tick off the rent",
            "at 5 people",
            "at 5 office",
            "since 5",
            "123pm",
            "call bob",
            "",
            "weekdayx",
        ] {
            assert!(!has_time_phrase(no), "{no}");
        }
    }

    #[test]
    fn the_focus_line_splits_at_its_marks() {
        let sets = focus_sets(
            "@1: #3 task \"a\" · created #7 task \"b\" · asked: #9 · acted #4 · earlier: #2 and · not a mark",
        );
        assert_eq!(
            sets,
            vec![
                ("focus", vec!["3".to_owned()]),
                ("created", vec!["7".to_owned()]),
                ("asked", vec!["9".to_owned()]),
                ("focus", vec!["4".to_owned()]),
                ("focus", vec!["2".to_owned()]),
            ]
        );
    }

    #[test]
    fn the_text_of_one_row_stops_at_the_next() {
        let line = "#4 task \"Pay rent\" due 2026-03-01 · #5 task \"Call Mo\" nickname \"Mo\"";
        assert_eq!(own_text("4", line), "#4 task \"Pay rent\" due 2026-03-01 ·");
        assert_eq!(own_text("5", line), "#5 task \"Call Mo\" nickname \"Mo\"");
        assert!(shows_date(own_text("4", line)));
        assert_eq!(nickname(own_text("5", line)), Some("Mo"));
    }

    #[test]
    fn a_string_is_written_as_python_writes_it() {
        assert_eq!(py_repr("mystery: x"), "'mystery: x'");
        assert_eq!(py_repr("it's"), "\"it's\"");
        assert_eq!(py_repr("a\nb\\"), "'a\\nb\\\\'");
        assert_eq!(py_repr("é\u{a0}"), "'é\\xa0'");
    }
}
