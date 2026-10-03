//! `Range` on `GET /v2/v/{vault}/o/{name}` (#1080).
//!
//! One byte range per request, which is what resuming a download needs. The
//! reading follows RFC 9110 §14: a `Range` the gateway does not understand —
//! another unit, several ranges, a malformed spec — is ignored and the whole
//! object is served; a range it understands but the object cannot satisfy is
//! `BAD_RANGE` (416), carrying the object's size.

use crate::rules::code::Refusal;

/// A range a client asks for: `first` through `last` inclusive, or to the end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub first: u64,
    pub last: Option<u64>,
}

impl ByteRange {
    /// The `Range` header's value: `bytes=first-last` or `bytes=first-`.
    #[must_use]
    pub fn header(&self) -> String {
        match self.last {
            Some(last) => format!("bytes={}-{last}", self.first),
            None => format!("bytes={}-", self.first),
        }
    }
}

/// The bytes a response carries: `first` through `last` inclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub first: u64,
    pub last: u64,
}

impl Span {
    /// How many bytes.
    #[must_use]
    pub const fn len(&self) -> u64 {
        self.last - self.first + 1
    }

    /// Never: a span holds at least one byte.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        false
    }

    /// The `Content-Range` header's value for an object of `size` bytes.
    #[must_use]
    pub fn content_range(&self, size: u64) -> String {
        format!("bytes {}-{}/{size}", self.first, self.last)
    }
}

/// What to serve of an object of `size` bytes for this `Range` header:
/// `None` is the whole object.
///
/// # Errors
///
/// `BAD_RANGE` for a range the object cannot satisfy.
pub fn resolve(header: Option<&str>, size: u64) -> Result<Option<Span>, Refusal> {
    let Some(spec) = header.and_then(|value| value.trim().strip_prefix("bytes=")) else {
        return Ok(None);
    };
    if spec.contains(',') {
        return Ok(None);
    }
    let Some((first, last)) = spec.trim().split_once('-') else {
        return Ok(None);
    };
    let unsatisfiable = Refusal::BadRange { size };
    if first.is_empty() {
        // A suffix: the last `n` bytes.
        let Ok(suffix) = last.parse::<u64>() else {
            return Ok(None);
        };
        if suffix == 0 || size == 0 {
            return Err(unsatisfiable);
        }
        return Ok(Some(Span {
            first: size.saturating_sub(suffix),
            last: size - 1,
        }));
    }
    let Ok(first) = first.parse::<u64>() else {
        return Ok(None);
    };
    let last = if last.is_empty() {
        None
    } else {
        let Ok(last) = last.parse::<u64>() else {
            return Ok(None);
        };
        if last < first {
            return Ok(None);
        }
        Some(last)
    };
    if first >= size {
        return Err(unsatisfiable);
    }
    Ok(Some(Span {
        first,
        last: last.map_or(size - 1, |last| last.min(size - 1)),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ranges_a_resumed_download_asks_for() {
        assert_eq!(resolve(None, 10), Ok(None));
        assert_eq!(
            resolve(Some("bytes=2-5"), 10),
            Ok(Some(Span { first: 2, last: 5 }))
        );
        assert_eq!(
            resolve(Some("bytes=4-"), 10),
            Ok(Some(Span { first: 4, last: 9 }))
        );
        assert_eq!(
            resolve(Some("bytes=8-99"), 10),
            Ok(Some(Span { first: 8, last: 9 }))
        );
        assert_eq!(
            resolve(Some("bytes=-3"), 10),
            Ok(Some(Span { first: 7, last: 9 }))
        );
        assert_eq!(
            resolve(Some("bytes=-30"), 10),
            Ok(Some(Span { first: 0, last: 9 }))
        );
        assert_eq!(Span { first: 2, last: 5 }.content_range(10), "bytes 2-5/10");
        assert_eq!(Span { first: 2, last: 5 }.len(), 4);
    }

    /// What the gateway does not understand, it ignores: the whole object.
    #[test]
    fn an_unreadable_range_serves_the_whole_object() {
        for header in [
            "items=0-1",
            "bytes=1-2,4-5",
            "bytes=x-2",
            "bytes=5-2",
            "bytes=7",
        ] {
            assert_eq!(resolve(Some(header), 10), Ok(None), "{header}");
        }
    }

    /// What it understands and cannot satisfy is `BAD_RANGE`, with the size.
    #[test]
    fn an_unsatisfiable_range_is_refused_with_the_size() {
        for header in ["bytes=10-", "bytes=10-12", "bytes=-0"] {
            assert_eq!(
                resolve(Some(header), 10),
                Err(Refusal::BadRange { size: 10 }),
                "{header}"
            );
        }
        assert_eq!(
            resolve(Some("bytes=0-"), 0),
            Err(Refusal::BadRange { size: 0 })
        );
    }

    #[test]
    fn a_client_range_spells_its_header() {
        assert_eq!(
            ByteRange {
                first: 3,
                last: Some(9)
            }
            .header(),
            "bytes=3-9"
        );
        assert_eq!(
            ByteRange {
                first: 3,
                last: None
            }
            .header(),
            "bytes=3-"
        );
    }
}
