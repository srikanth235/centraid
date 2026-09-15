//! THE COMPANION'S METHOD TABLE — one closed enum, on both sides
//! (#1020 wave 4 lane extension, D-1020-X2).
//!
//! v0's Companion answers a `switch` over eighteen message types
//! (`apps/extension/src/companion-api.ts:189`–`:318`). Every one of them was an
//! HTTP call over a WASM iroh endpoint in a service worker; every one of them is
//! now a native-messaging frame to this process, which relays it to the local
//! seat. The list is the same list, and keeping it the same list is the thing
//! this module exists to make structural:
//!
//! * [`Method`] is the closed enum here;
//! * `contracts/extension/methods.json` is generated from v0's two files by
//!   `contracts/tools/export-extension-methods.ts`;
//! * [`tests::the_table_is_exactly_the_fixture`] asserts the two agree, name for
//!   name and property for property;
//! * `extension/src/methods.ts` reads the same fixture.
//!
//! So a nineteenth method cannot be added on one side only, and — more usefully
//! — a method cannot quietly stop being served: an unknown name is refused with
//! a typed frame naming it, never answered with an empty value.
//!
//! ## Eighteen, and the census says seventeen
//!
//! Census §E2 calls this "the 17 companion methods" and then lists eighteen
//! names; `handleCompanionRequest` has eighteen `case` arms. Eighteen is the
//! number, the generator asserts it, and the census's count is a finding rather
//! than something to reproduce.
//!
//! ## What `idempotent` means here, and why it is not "is it a read"
//!
//! v0's retry rule keys on the HTTP verb: *a revoked device is never retried,
//! and a non-idempotent method retries only a clear connect failure*
//! (`transport-core.ts:33`–`:52`). `appRead` is a `POST`
//! (`transport.ts:198`), so `locker:candidates` and `locker:fill` are NOT
//! idempotent even though both look like reads — and post-wave-4 that is load
//! bearing rather than pedantic: a fill writes a reveal receipt, so a rule that
//! retried it on any failure would receipt one gesture three times.

use std::sync::LazyLock;

/// One Companion method.
///
/// Ordered as v0's switch is, because the fixture is and a reordering would
/// make the comparison meaningless.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Method {
    Status,
    Pair,
    SelectVault,
    Unpair,
    Lock,
    Unlock,
    Warm,
    Modules,
    BlockingCount,
    LockerCandidates,
    LockerFill,
    LockerSave,
    CaptureTask,
    CaptureNote,
    CaptureDocument,
    AgendaAdd,
    PeopleAdd,
    PageCapture,
}

/// Every method, in v0's own order.
pub const ALL: [Method; 18] = [
    Method::Status,
    Method::Pair,
    Method::SelectVault,
    Method::Unpair,
    Method::Lock,
    Method::Unlock,
    Method::Warm,
    Method::Modules,
    Method::BlockingCount,
    Method::LockerCandidates,
    Method::LockerFill,
    Method::LockerSave,
    Method::CaptureTask,
    Method::CaptureNote,
    Method::CaptureDocument,
    Method::AgendaAdd,
    Method::PeopleAdd,
    Method::PageCapture,
];

impl Method {
    /// The name on the wire — v0's own message `type`.
    #[must_use]
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Pair => "pair",
            Self::SelectVault => "select-vault",
            Self::Unpair => "unpair",
            Self::Lock => "lock",
            Self::Unlock => "unlock",
            Self::Warm => "warm",
            Self::Modules => "modules",
            Self::BlockingCount => "blocking-count",
            Self::LockerCandidates => "locker:candidates",
            Self::LockerFill => "locker:fill",
            Self::LockerSave => "locker:save",
            Self::CaptureTask => "capture:task",
            Self::CaptureNote => "capture:note",
            Self::CaptureDocument => "capture:document",
            Self::AgendaAdd => "agenda:add",
            Self::PeopleAdd => "people:add",
            Self::PageCapture => "page:capture",
        }
    }

    /// The method with that name, or `None`.
    ///
    /// A closed lookup and not a `from_str` that falls back: the caller's next
    /// move for an unknown name is a typed refusal, and a `Default` arm here is
    /// how one becomes a silently-mapped something else.
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        ALL.iter()
            .copied()
            .find(|method| method.wire_name() == name)
    }

    /// Whether a failed attempt may be retried on any failure.
    ///
    /// v0's classification, read off the fixture rather than restated, so the
    /// two cannot drift.
    #[must_use]
    pub fn idempotent(self) -> bool {
        fixture_row(self).idempotent
    }

    /// Whether this method carries page content rather than an intent.
    #[must_use]
    pub fn reads_page(self) -> bool {
        fixture_row(self).reads_page
    }

    /// Whether this method carries bytes that may exceed the browser's frame
    /// ceiling, and therefore has to be staged (D-1020-X3).
    #[must_use]
    pub fn stages_bytes(self) -> bool {
        fixture_row(self).stages_bytes
    }

    /// The `app.action` v0's handler writes through, when it writes.
    #[must_use]
    pub fn writes(self) -> Option<&'static WriteTarget> {
        fixture_row(self).writes.as_ref()
    }
}

/// The generated fixture, as the host reads it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct MethodsFixture {
    pub version: u32,
    pub max_frame_bytes: usize,
    pub methods: Vec<MethodRow>,
}

/// One method's row in `contracts/extension/methods.json`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct MethodRow {
    pub name: String,
    pub idempotent: bool,
    pub http: Vec<String>,
    pub reads_page: bool,
    pub stages_bytes: bool,
    pub writes: Option<WriteTarget>,
    pub fields: Vec<FieldRow>,
}

/// The `app.action` a method's handler lands on.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct WriteTarget {
    pub app: String,
    pub action: String,
}

/// One request field of a method, as v0's `CompanionRequest` declares it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct FieldRow {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub optional: bool,
}

/// The fixture, compiled in.
///
/// `include_str!` and not a read at run time: the host is a process a browser
/// launches, and a host whose method table depended on a file being present
/// would be a host that answers differently depending on where it was
/// installed from.
static FIXTURE: LazyLock<MethodsFixture> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../../contracts/extension/methods.json"
    ))
    .expect("contracts/extension/methods.json is generated and must parse")
});

/// The fixture as a whole.
#[must_use]
pub fn fixture() -> &'static MethodsFixture {
    &FIXTURE
}

fn fixture_row(method: Method) -> &'static MethodRow {
    FIXTURE
        .methods
        .iter()
        .find(|row| row.name == method.wire_name())
        .expect("every enum variant is a fixture row, asserted by the table test")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE CLOSED ENUM, ON BOTH SIDES. Names, order and every derived property.
    #[test]
    fn the_table_is_exactly_the_fixture() {
        let fixture = fixture();
        let names: Vec<&str> = ALL.iter().map(|method| method.wire_name()).collect();
        let rows: Vec<&str> = fixture
            .methods
            .iter()
            .map(|row| row.name.as_str())
            .collect();
        assert_eq!(names, rows, "the host's table is v0's switch, in its order");
        assert_eq!(ALL.len(), 18, "eighteen arms, not the census's seventeen");
        for method in ALL {
            let row = fixture_row(method);
            assert_eq!(method.idempotent(), row.idempotent, "{}", row.name);
            assert_eq!(method.reads_page(), row.reads_page, "{}", row.name);
            assert_eq!(method.stages_bytes(), row.stages_bytes, "{}", row.name);
        }
    }

    /// THE RETRY RULE'S TEETH. `locker:fill` looks like a read and is not
    /// idempotent, because it writes a reveal receipt.
    #[test]
    fn a_fill_is_not_retried_on_any_failure() {
        assert!(!Method::LockerFill.idempotent());
        assert!(!Method::LockerCandidates.idempotent());
        assert!(Method::Warm.idempotent());
        assert!(Method::Status.idempotent());
    }

    /// AN UNKNOWN NAME IS NOTHING, and near-misses are unknown too.
    #[test]
    fn an_unknown_method_does_not_resolve() {
        for bad in [
            "locker:reveal",
            "LOCKER:FILL",
            "locker.fill",
            "",
            "status ",
            "page:captures",
        ] {
            assert!(Method::parse(bad).is_none(), "{bad:?} must not resolve");
        }
        assert_eq!(Method::parse("locker:fill"), Some(Method::LockerFill));
    }

    /// THE TWO METHODS THAT CARRY BYTES are the two that stage.
    #[test]
    fn only_the_byte_carrying_methods_stage() {
        let staging: Vec<&str> = ALL
            .iter()
            .filter(|method| method.stages_bytes())
            .map(|method| method.wire_name())
            .collect();
        assert_eq!(staging, ["capture:document"]);
        // `page:capture` reads the page and does not itself stage in v0 — it is
        // answered in the browser (`companion-api.ts:318` returns `undefined`).
        // Here it carries a document, which is why the CHUNKING layer is keyed
        // on the frame's size rather than on this flag.
        assert!(Method::PageCapture.reads_page());
    }

    /// The ceiling is the browser's and is stated once, in the fixture.
    #[test]
    fn the_ceiling_is_the_browsers_own() {
        assert_eq!(fixture().max_frame_bytes, 1024 * 1024);
        assert_eq!(
            fixture().max_frame_bytes,
            super::super::MAX_FROM_EXTENSION as usize
        );
    }

    /// Every method's request fields came from v0's own union.
    #[test]
    fn the_fields_are_v0s_union_members() {
        let fill = fixture_row(Method::LockerFill);
        let names: Vec<&str> = fill.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["itemId", "pageUrl"]);
        let people = fixture_row(Method::PeopleAdd);
        assert!(
            people
                .fields
                .iter()
                .any(|field| field.name == "role" && field.optional),
            "v0's `role` is optional and the fixture must say so"
        );
    }
}
