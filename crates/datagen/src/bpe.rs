//! A byte-level BPE encoder and decoder that reads a Hugging Face `tokenizer.json`: the one shape Qwen3.5 uses, and nothing else.
//!
//! The data pipeline used to link the `tokenizers` crate for this. That crate pulls in `paste`, which RUSTSEC-2024-0436 marks
//! unmaintained, and `deny.toml` has no ignores. What the chat model needs from it is small, so it is written here:
//!
//! 1. **Added tokens** (`<|im_start|>`, `<think>`, `<tool_call>`, ...) are cut out of the raw text first, leftmost and longest,
//!    each as the one id it is. None is normalised (the file says `normalized: false`) and none is added around the text.
//! 2. **Normalizer**: NFC on every stretch between added tokens, or none.
//! 3. **Pre-tokenizer**: a `Split` on the file's regex with behaviour `Isolated` (each match is a piece and so is each gap
//!    between matches), then `ByteLevel` with its own regex off. The regex uses a lookahead (`\s+(?!\S)`), which is why this
//!    is `fancy-regex`.
//! 4. **Model**: each piece's bytes are spelled with the GPT-2 byte-to-character map and merged by lowest rank until no
//!    merge applies; each result is looked up in the vocab.
//!
//! Anything else in the file (another normalizer, another model, a dropout, a merge prefix, an added token that is
//! normalised or strips space) is refused when the file is read, not guessed at.
//!
//! Offsets are byte ranges of the text that was passed in. A token's range is the union of its characters' ranges; the
//! bytes of one multibyte character are separate tokens (or inside one) that share the character's range. When NFC changes a
//! stretch, the ranges are those of the clusters of the original text that composed, a whole stretch if they cannot be
//! told apart.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

use anyhow::{Context, Result, anyhow, bail, ensure};
use fancy_regex::Regex;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::canonical_combining_class;

/// The ids of a text and the byte range of the text each covers.
pub type Tokens = (Vec<u32>, Vec<(usize, usize)>);

/// A byte-level BPE tokenizer.
pub struct Bpe {
    nfc: bool,
    split: Regex,
    /// The id of the one-byte token of each byte.
    byte_ids: [u32; 256],
    /// `(left, right)` to `(rank, merged)`.
    merges: HashMap<(u32, u32), (u32, u32)>,
    /// The bytes each id spells, `None` for an id the file does not define.
    spelling: Vec<Option<Vec<u8>>>,
    /// The added tokens, longest first.
    added: Vec<(Vec<u8>, u32)>,
}

/// The GPT-2 map from a byte to the character that stands for it in a vocab.
pub(crate) fn byte_chars() -> [char; 256] {
    let mut table = ['\0'; 256];
    let mut next = 0x100_u32;
    for byte in 0..=255_u32 {
        let printable = (33..=126).contains(&byte) || (161..=172).contains(&byte) || byte >= 174;
        table[byte as usize] = if printable {
            char::from_u32(byte)
        } else {
            next += 1;
            char::from_u32(next - 1)
        }
        .unwrap_or('\0');
    }
    table
}

impl Bpe {
    /// Read a `tokenizer.json`.
    ///
    /// # Errors
    ///
    /// If the text is not JSON, is not the shape this reads (see the module doc), or its vocab and merges disagree.
    pub fn from_json(text: &str) -> Result<Self> {
        let root: Value = serde_json::from_str(text).context("tokenizer.json is not JSON")?;
        let nfc = match root.get("normalizer") {
            None | Some(Value::Null) => false,
            Some(n) if n["type"] == "NFC" => true,
            Some(other) => bail!("unsupported normalizer: {other}"),
        };
        let split = split_pattern(&root["pre_tokenizer"])?;
        let model = &root["model"];
        ensure!(
            model["type"] == "BPE",
            "unsupported model: {}",
            model["type"]
        );
        for (key, ok) in [
            ("dropout", model["dropout"].is_null()),
            ("unk_token", model["unk_token"].is_null()),
            ("byte_fallback", model["byte_fallback"] != true),
            ("ignore_merges", model["ignore_merges"] != true),
            (
                "continuing_subword_prefix",
                empty(&model["continuing_subword_prefix"]),
            ),
            ("end_of_word_suffix", empty(&model["end_of_word_suffix"])),
        ] {
            ensure!(ok, "unsupported model setting: {key}");
        }

        let chars = byte_chars();
        let vocab: HashMap<&str, u32> = model["vocab"]
            .as_object()
            .ok_or_else(|| anyhow!("model.vocab is not an object"))?
            .iter()
            .map(|(token, id)| {
                let id = id.as_u64().and_then(|n| u32::try_from(n).ok());
                id.map(|id| (token.as_str(), id))
                    .ok_or_else(|| anyhow!("vocab id of {token:?} is not a u32"))
            })
            .collect::<Result<_>>()?;
        let mut byte_ids = [0_u32; 256];
        for (byte, c) in chars.iter().enumerate() {
            byte_ids[byte] = *vocab
                .get(c.to_string().as_str())
                .ok_or_else(|| anyhow!("the vocab has no token for byte {byte:#04x}"))?;
        }

        let char_bytes: HashMap<char, u8> = chars
            .iter()
            .enumerate()
            .map(|(byte, c)| (*c, u8::try_from(byte).unwrap_or(0)))
            .collect();
        let mut spelling: Vec<Option<Vec<u8>>> = Vec::new();
        for (token, id) in &vocab {
            let bytes = token
                .chars()
                .map(|c| char_bytes.get(&c).copied())
                .collect::<Option<Vec<u8>>>()
                .ok_or_else(|| {
                    anyhow!("vocab token {token:?} has a character outside the byte map")
                })?;
            set(&mut spelling, *id, bytes)?;
        }

        let mut merges = HashMap::new();
        for (rank, merge) in model["merges"]
            .as_array()
            .ok_or_else(|| anyhow!("model.merges is not an array"))?
            .iter()
            .enumerate()
        {
            let (left, right) = match merge {
                Value::String(pair) => pair
                    .split_once(' ')
                    .map(|(a, b)| (a.to_owned(), b.to_owned()))
                    .ok_or_else(|| anyhow!("merge {rank} is not two tokens: {pair:?}"))?,
                Value::Array(pair) if pair.len() == 2 => (
                    pair[0].as_str().unwrap_or_default().to_owned(),
                    pair[1].as_str().unwrap_or_default().to_owned(),
                ),
                other => bail!("merge {rank} is not a pair: {other}"),
            };
            let lookup = |token: &str| {
                vocab.get(token).copied().ok_or_else(|| {
                    anyhow!("merge {rank} names {token:?}, which is not in the vocab")
                })
            };
            let merged = lookup(&format!("{left}{right}"))?;
            let key = (lookup(&left)?, lookup(&right)?);
            // The first rank of a pair is the one that applies.
            merges
                .entry(key)
                .or_insert((u32::try_from(rank).context("too many merges")?, merged));
        }

        let mut added = Vec::new();
        for token in root["added_tokens"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
        {
            let content = token["content"]
                .as_str()
                .ok_or_else(|| anyhow!("an added token has no content"))?;
            for flag in ["normalized", "lstrip", "rstrip", "single_word"] {
                ensure!(
                    token[flag] != true,
                    "added token {content:?} sets {flag}, which this does not read"
                );
            }
            let id = token["id"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| anyhow!("added token {content:?} has no id"))?;
            ensure!(!content.is_empty(), "an added token is empty");
            set(&mut spelling, id, content.as_bytes().to_vec())?;
            added.push((content.as_bytes().to_vec(), id));
        }
        added.sort_by_key(|(content, _)| Reverse(content.len()));

        Ok(Self {
            nfc,
            split,
            byte_ids,
            merges,
            spelling,
            added,
        })
    }

    /// The ids of `text` and the byte range of `text` each covers. Added tokens written in the text are the tokens
    /// themselves; none is added around it.
    ///
    /// # Errors
    ///
    /// If the pre-tokenizer's regex gives up on the text (its backtracking limit).
    pub fn encode(&self, text: &str) -> Result<Tokens> {
        let mut ids = Vec::new();
        let mut offsets = Vec::new();
        let mut plain = 0;
        let mut at = 0;
        let bytes = text.as_bytes();
        while at < bytes.len() {
            let hit = self
                .added
                .iter()
                .find(|(content, _)| bytes[at..].starts_with(content));
            if let Some((content, id)) = hit {
                self.stretch(text, plain, at, &mut ids, &mut offsets)?;
                ids.push(*id);
                offsets.push((at, at + content.len()));
                at += content.len();
                plain = at;
            } else {
                at += text[at..].chars().next().map_or(1, char::len_utf8);
            }
        }
        self.stretch(text, plain, text.len(), &mut ids, &mut offsets)?;
        Ok((ids, offsets))
    }

    /// The text of `ids`, added tokens kept.
    ///
    /// # Errors
    ///
    /// If an id is not in the file.
    pub fn decode(&self, ids: &[u32]) -> Result<String> {
        let mut bytes = Vec::new();
        for id in ids {
            let spelled = self
                .spelling
                .get(*id as usize)
                .and_then(Option::as_ref)
                .ok_or_else(|| anyhow!("token id {id} is not in the tokenizer"))?;
            bytes.extend_from_slice(spelled);
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// The tokens of `text[from..to]`, which holds no added token.
    fn stretch(
        &self,
        text: &str,
        from: usize,
        to: usize,
        ids: &mut Vec<u32>,
        offsets: &mut Vec<(usize, usize)>,
    ) -> Result<()> {
        if from == to {
            return Ok(());
        }
        let (normal, ranges) = self.normalise(&text[from..to], from);
        // one original range for each byte of the normalised text
        let mut at = 0;
        let mut pieces = Vec::new();
        for found in self.split.find_iter(&normal) {
            let found = found.map_err(|error| anyhow!("pre-tokenizer: {error}"))?;
            if at < found.start() {
                pieces.push((at, found.start()));
            }
            pieces.push((found.start(), found.end()));
            at = found.end();
        }
        if at < normal.len() {
            pieces.push((at, normal.len()));
        }
        for (start, end) in pieces {
            self.piece(
                &normal.as_bytes()[start..end],
                &ranges[start..end],
                ids,
                offsets,
            );
        }
        Ok(())
    }

    /// `stretch` normalised, and for each byte of it the range of the original text it came from.
    fn normalise(&self, stretch: &str, base: usize) -> (String, Vec<(usize, usize)>) {
        let identity = |s: &str| {
            let mut ranges = Vec::with_capacity(s.len());
            for (i, c) in s.char_indices() {
                ranges.extend(std::iter::repeat_n(
                    (base + i, base + i + c.len_utf8()),
                    c.len_utf8(),
                ));
            }
            (s.to_owned(), ranges)
        };
        if !self.nfc || unicode_normalization::is_nfc(stretch) {
            return identity(stretch);
        }
        // Clusters: a starter and what follows it. When each cluster normalises alone to what it contributes to the whole,
        // a normalised byte maps to its cluster; otherwise the whole stretch is one cluster.
        let whole: String = stretch.nfc().collect();
        let mut starts: Vec<usize> = stretch
            .char_indices()
            .filter(|(_, c)| canonical_combining_class(*c) == 0)
            .map(|(i, _)| i)
            .collect();
        if starts.first() != Some(&0) {
            starts.insert(0, 0);
        }
        let mut pieces: Vec<(String, usize, usize)> = starts
            .iter()
            .enumerate()
            .map(|(k, a)| {
                let b = starts.get(k + 1).copied().unwrap_or(stretch.len());
                (stretch[*a..b].nfc().collect(), *a, b)
            })
            .collect();
        if pieces.iter().map(|(s, ..)| s.as_str()).collect::<String>() != whole {
            pieces = vec![(whole, 0, stretch.len())];
        }
        let mut text = String::new();
        let mut ranges = Vec::new();
        for (s, a, b) in pieces {
            ranges.extend(std::iter::repeat_n((base + a, base + b), s.len()));
            text.push_str(&s);
        }
        (text, ranges)
    }

    /// Merge one pre-tokenized piece and push its tokens. `ranges` holds the original range of each byte of the piece.
    fn piece(
        &self,
        piece: &[u8],
        ranges: &[(usize, usize)],
        ids: &mut Vec<u32>,
        offsets: &mut Vec<(usize, usize)>,
    ) {
        // A doubly linked list of symbols; a heap of the merges that apply, stale ones skipped when popped.
        struct Symbol {
            id: u32,
            from: usize,
            to: usize,
            prev: Option<usize>,
            next: Option<usize>,
            alive: bool,
        }
        let n = piece.len();
        let mut symbols: Vec<Symbol> = (0..n)
            .map(|i| Symbol {
                id: self.byte_ids[usize::from(piece[i])],
                from: ranges[i].0,
                to: ranges[i].1,
                prev: i.checked_sub(1),
                next: (i + 1 < n).then_some(i + 1),
                alive: true,
            })
            .collect();
        let mut heap = BinaryHeap::new();
        let queue = |heap: &mut BinaryHeap<Reverse<(u32, usize, u32, u32)>>,
                     symbols: &[Symbol],
                     left: usize| {
            if let Some(right) = symbols[left].next
                && let Some((rank, _)) = self.merges.get(&(symbols[left].id, symbols[right].id))
            {
                heap.push(Reverse((*rank, left, symbols[left].id, symbols[right].id)));
            }
        };
        for i in 0..n {
            queue(&mut heap, &symbols, i);
        }
        while let Some(Reverse((_, left, left_id, right_id))) = heap.pop() {
            let Some(right) = symbols[left].next else {
                continue;
            };
            if !symbols[left].alive
                || !symbols[right].alive
                || symbols[left].id != left_id
                || symbols[right].id != right_id
            {
                continue;
            }
            let Some((_, merged)) = self.merges.get(&(left_id, right_id)) else {
                continue;
            };
            symbols[left].id = *merged;
            symbols[left].to = symbols[right].to;
            symbols[left].next = symbols[right].next;
            symbols[right].alive = false;
            if let Some(after) = symbols[right].next {
                symbols[after].prev = Some(left);
            }
            if let Some(before) = symbols[left].prev {
                queue(&mut heap, &symbols, before);
            }
            queue(&mut heap, &symbols, left);
        }
        for symbol in symbols.iter().filter(|s| s.alive) {
            ids.push(symbol.id);
            offsets.push((symbol.from, symbol.to));
        }
    }
}

fn empty(value: &Value) -> bool {
    value.is_null() || value.as_str() == Some("")
}

fn set(spelling: &mut Vec<Option<Vec<u8>>>, id: u32, bytes: Vec<u8>) -> Result<()> {
    let at = id as usize;
    ensure!(at < 1 << 24, "token id {id} is out of range");
    if spelling.len() <= at {
        spelling.resize(at + 1, None);
    }
    ensure!(spelling[at].is_none(), "token id {id} is defined twice");
    spelling[at] = Some(bytes);
    Ok(())
}

/// The regex of a pre-tokenizer of the one supported shape: `Sequence[Split(Regex, Isolated), ByteLevel(use_regex: false)]`.
fn split_pattern(pre: &Value) -> Result<Regex> {
    let unsupported = || anyhow!("unsupported pre_tokenizer: {pre}");
    let parts = pre["pretokenizers"].as_array().ok_or_else(unsupported)?;
    let [split, byte_level] = parts.as_slice() else {
        return Err(unsupported());
    };
    let ok = pre["type"] == "Sequence"
        && split["type"] == "Split"
        && split["behavior"] == "Isolated"
        && split["invert"] != true
        && byte_level["type"] == "ByteLevel"
        && byte_level["use_regex"] != true
        && byte_level["add_prefix_space"] != true;
    ensure!(ok, unsupported());
    let pattern = split["pattern"]["Regex"].as_str().ok_or_else(unsupported)?;
    Regex::new(pattern).with_context(|| format!("pre-tokenizer regex {pattern:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_byte_map_is_the_gpt2_one() {
        let chars = byte_chars();
        assert_eq!(chars[usize::from(b'a')], 'a');
        assert_eq!(chars[usize::from(b' ')], 'Ġ');
        assert_eq!(chars[usize::from(b'\n')], 'Ċ');
        assert_eq!(chars[0], 'Ā');
        assert_eq!(chars[255], 'ÿ');
        let distinct: std::collections::HashSet<char> = chars.iter().copied().collect();
        assert_eq!(distinct.len(), 256);
    }

    /// A tiny tokenizer: the byte alphabet, the merges `h e`, `he l`, `hel l` and `Ġ w`, one added token.
    fn tiny() -> Bpe {
        let mut vocab = serde_json::Map::new();
        let mut alphabet = byte_chars().to_vec();
        alphabet.sort_unstable();
        for (i, c) in alphabet.iter().enumerate() {
            vocab.insert(c.to_string(), serde_json::json!(i));
        }
        for (k, t) in ["he", "hel", "hell", "Ġw"].iter().enumerate() {
            vocab.insert((*t).to_owned(), serde_json::json!(256 + k));
        }
        let json = serde_json::json!({
            "added_tokens": [{"id": 300, "content": "<s>", "special": true, "normalized": false,
                              "lstrip": false, "rstrip": false, "single_word": false}],
            "normalizer": {"type": "NFC"},
            "pre_tokenizer": {"type": "Sequence", "pretokenizers": [
                {"type": "Split", "pattern": {"Regex": r"\s+(?!\S)|\s+|\w+|[^\s\w]+"}, "behavior": "Isolated", "invert": false},
                {"type": "ByteLevel", "add_prefix_space": false, "trim_offsets": false, "use_regex": false}]},
            "model": {"type": "BPE", "dropout": null, "unk_token": null, "continuing_subword_prefix": "",
                      "end_of_word_suffix": "", "byte_fallback": false, "ignore_merges": false, "vocab": vocab,
                      "merges": ["h e", "he l", "hel l", "Ġ w"]},
        });
        Bpe::from_json(&json.to_string()).unwrap()
    }

    #[test]
    fn merges_apply_by_rank_and_offsets_are_bytes_of_the_text() {
        let bpe = tiny();
        let (ids, offsets) = bpe.encode("hell hello").unwrap();
        // `hell` merges whole; the space stays its own piece (the regex takes `\s+(?!\S)` only before whitespace)
        assert_eq!(ids[0], 258);
        assert_eq!(offsets[0], (0, 4));
        assert_eq!(bpe.decode(&ids).unwrap(), "hell hello");
        let (ids, offsets) = bpe.encode("é").unwrap();
        assert_eq!((ids.len(), offsets), (2, vec![(0, 2), (0, 2)]));
    }

    #[test]
    fn an_added_token_is_cut_out_whole_and_nfc_composes_around_it() {
        let bpe = tiny();
        let (ids, offsets) = bpe.encode("a<s>e\u{301}<s>").unwrap();
        assert_eq!(ids.iter().filter(|id| **id == 300).count(), 2);
        assert_eq!(offsets[1], (1, 4));
        // `e` + combining acute composes to `é`, two bytes, and its range is the three bytes it came from
        let accent: Vec<_> = offsets.iter().filter(|o| **o == (4, 7)).collect();
        assert_eq!(accent.len(), 2);
        assert_eq!(bpe.decode(&ids).unwrap(), "a<s>\u{e9}<s>");
    }

    #[test]
    fn a_file_of_another_shape_is_refused() {
        assert!(Bpe::from_json("{}").is_err());
        let json = serde_json::json!({"model": {"type": "WordPiece"}});
        assert!(Bpe::from_json(&json.to_string()).is_err());
    }
}
