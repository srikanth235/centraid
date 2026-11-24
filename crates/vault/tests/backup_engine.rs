//! The engine against `MemoryStore` (spec §6.2, §6.3, #1209, L5): what a pass sends, in what order,
//! and what it asks. Counts of calls and objects, never durations.

mod backup_support;

use std::cell::RefCell;
use std::collections::BTreeSet;
use std::rc::Rc;

use backup_support::{Rig, T0};
use centraid_media::sealed::{Class, Name};
use centraid_vault::backup::engine::{
    self, Env, GatewayPass, Link, Policy, Scheduler, Step, head_recheck_every,
};
use centraid_vault::backup::retention::{self, Collected};
use centraid_vault::backup::store::{
    Deleted, FrameAnswer, Head, HeldEntry, MemoryStore, NameCheck, ObjectEntry, Outgoing,
    SnapshotEntry, Store, StoreError,
};
use centraid_vault::backup::tree;

fn photos(rig: &Rig, count: u8) {
    for n in 0..count {
        let original = rig.add_original(
            &format!("original photo number {n} ")
                .repeat(200)
                .into_bytes(),
        );
        rig.add_thumbnail(
            &original,
            format!("thumbnail {n}").as_bytes(),
            &format!("2026-01-{:02}T03:04:05.000Z", n + 1),
        );
    }
}

/// Run one pass per store to completion; the passes' stats are returned.
fn run(rig: &Rig, stores: &[&MemoryStore], policy: Policy, now_ms: u64) -> Vec<engine::PassStats> {
    let env = Env::new(
        rig.vault(),
        &rig.keys,
        &rig.state,
        &rig.staging,
        policy,
        now_ms,
    );
    let passes: Vec<GatewayPass<'_, '_>> = stores
        .iter()
        .map(|store| GatewayPass::new(&env, *store as &dyn Store).expect("a pass"))
        .collect();
    let mut scheduler = Scheduler::new(passes, 8);
    scheduler.run(10_000).expect("runs");
    assert!(
        scheduler.passes.iter().all(|pass| pass.is_over()),
        "every pass ended"
    );
    scheduler.passes.iter().map(|pass| pass.stats).collect()
}

fn gateway(rig: &Rig, store: &MemoryStore) -> centraid_vault::backup::state::Gateway {
    rig.state
        .gateway(store.gateway_id())
        .expect("reads")
        .expect("paired")
}

fn front(rig: &Rig) -> (MemoryStore, centraid_media::sealed::Ref) {
    let store = MemoryStore::new("desk");
    store.set_clock_ms(T0 * 2);
    rig.pair(&store);
    let taken = rig.snapshot(T0);
    (store, taken.root)
}

#[test]
fn a_first_backup_confirms_records_then_thumbnails_then_originals() {
    let rig = Rig::new("first");
    rig.grow(30, "first");
    photos(&rig, 3);
    let (store, root) = front(&rig);
    let stats = run(&rig, &[&store], Policy::WIFI, T0);

    assert_eq!(store.head().expect("head").expect("set").name, root.name);
    let gateway = gateway(&rig, &store);
    assert_eq!(gateway.conf.map(|(name, _)| name), Some(root.name));
    assert_eq!(gateway.troot.map(|(name, _)| name), Some(root.name));
    assert_eq!(gateway.oroot.map(|(name, _)| name), Some(root.name));
    let standing = engine::standing(&rig.state, store.gateway_id()).expect("standing");
    assert!(standing.records.is_some() && standing.thumbnails && standing.originals);
    assert_eq!(stats[0].heads_set, 1);
    // Every object of the tree is on the gateway, whole.
    let everything = tree::everything_of(&rig.state, &root).expect("names");
    let held: BTreeSet<Name> = store.contents().into_iter().map(|(name, _)| name).collect();
    assert!(everything.is_subset(&held));
    let debt = engine::debt(&rig.env(T0), store.gateway_id()).expect("debt");
    assert_eq!((debt.records, debt.thumbnails, debt.originals), (0, 0, 0));
}

#[test]
fn a_one_page_edit_stores_three_objects_with_no_exists_calls() {
    let rig = Rig::new("onepage");
    rig.grow(30, "onepage");
    photos(&rig, 2);
    let (store, _) = front(&rig);
    run(&rig, &[&store], Policy::WIFI, T0);
    let before = store.counts();

    let raw = rig.raw();
    raw.execute("UPDATE vault SET writes = writes + 1", [])
        .expect("one page");
    drop(raw);
    let taken = rig.snapshot(T0 + 1_000);
    assert_eq!(taken.ranges_new, 1);
    let stats = run(&rig, &[&store], Policy::WIFI, T0 + 1_000);

    let after = store.counts();
    assert_eq!(
        after.stored - before.stored,
        3,
        "one range, one leaf, one root"
    );
    assert_eq!(
        after.exists - before.exists,
        0,
        "an incremental pass asks nothing"
    );
    assert_eq!(stats[0].stored, 3);
    assert_eq!(stats[0].exists_calls, 0);
    assert_eq!(
        store.head().expect("head").expect("set").name,
        taken.root.name
    );
}

#[test]
fn a_recovery_pass_uses_exists() {
    let rig = Rig::new("recovery");
    rig.grow(30, "recovery");
    photos(&rig, 2);
    let (store, _) = front(&rig);
    let backup = store.checkpoint();
    run(&rig, &[&store], Policy::WIFI, T0);
    rig.raw()
        .execute("UPDATE vault SET writes = writes + 1", [])
        .expect("an edit");
    rig.snapshot(T0 + 1_000);
    run(&rig, &[&store], Policy::WIFI, T0 + 1_000);

    // The gateway's data directory comes back from before the first backup: its head is gone.
    store.roll_back(&backup);
    let taken = rig.snapshot(T0 + 2_000);
    let before = store.counts();
    let stats = run(&rig, &[&store], Policy::WIFI, T0 + 2_000);
    assert!(
        stats[0].exists_calls > 0,
        "recovery learns what is held by asking"
    );
    assert!(store.counts().exists > before.exists);
    assert_eq!(
        store.head().expect("head").expect("set").name,
        taken.root.name
    );
    let everything = tree::everything_of(&rig.state, &taken.root).expect("names");
    let held: BTreeSet<Name> = store.contents().into_iter().map(|(name, _)| name).collect();
    assert!(everything.is_subset(&held), "everything is back");
}

#[test]
fn a_pass_killed_after_any_step_resumes_and_ends_the_same() {
    // The crash happens after step `k`, for every k up to the pass's own length; a new pass then
    // runs to the end and finds everything whole, the head set once, nothing stored twice.
    let mut length = None;
    for kill_after in 0..40 {
        let rig = Rig::new(&format!("resume{kill_after}"));
        rig.grow(20, "resume");
        photos(&rig, 3);
        let (store, root) = front(&rig);
        let env = rig.env(T0);
        let mut pass = GatewayPass::new(&env, &store).expect("a pass");
        let mut done = false;
        for _ in 0..kill_after {
            match pass.step().expect("steps") {
                Step::Done => {
                    done = true;
                    break;
                }
                Step::Stopped(stop) => panic!("stopped: {stop:?}"),
                Step::Worked | Step::Restarted => {}
            }
        }
        drop(pass);
        let mut resumed = GatewayPass::new(&env, &store).expect("a pass");
        while matches!(
            resumed.step().expect("steps"),
            Step::Worked | Step::Restarted
        ) {}
        assert_eq!(
            store.head().expect("head").expect("set").name,
            root.name,
            "k = {kill_after}"
        );
        assert!(
            engine::standing(&rig.state, store.gateway_id())
                .expect("standing")
                .originals
        );
        let everything = tree::everything_of(&rig.state, &root).expect("names");
        let held: BTreeSet<Name> = store.contents().into_iter().map(|(name, _)| name).collect();
        assert_eq!(everything, held, "exactly the tree, k = {kill_after}");
        assert_eq!(
            store.counts().heads,
            1,
            "the head was set once, k = {kill_after}"
        );
        if done {
            length = Some(kill_after);
            break;
        }
    }
    assert!(
        length.is_some_and(|steps| steps > 3),
        "the pass is several steps long"
    );
}

type Event = (String, &'static str, Option<Name>);

#[derive(Clone)]
struct Observed {
    inner: MemoryStore,
    events: Rc<RefCell<Vec<Event>>>,
}

impl Store for Observed {
    fn gateway_id(&self) -> &str {
        self.inner.gateway_id()
    }
    fn exists(&self, names: &[Name]) -> Result<Vec<Name>, StoreError> {
        self.inner.exists(names)
    }
    fn bundle(&self, parts: &[Outgoing]) -> Result<Vec<(Name, FrameAnswer)>, StoreError> {
        self.events.borrow_mut().push((
            self.inner.gateway_id().to_owned(),
            "bundle",
            parts.first().map(|part| part.name),
        ));
        self.inner.bundle(parts)
    }
    fn get(&self, name: &Name, sink: &mut dyn std::io::Write) -> Result<u64, StoreError> {
        self.inner.get(name, sink)
    }
    fn check_name(&self, name: &Name) -> Result<NameCheck, StoreError> {
        self.inner.check_name(name)
    }
    fn head(&self) -> Result<Option<Head>, StoreError> {
        self.inner.head()
    }
    fn generation(&self) -> u64 {
        self.inner.generation()
    }
    fn set_head(
        &self,
        name: &Name,
        prev: Option<&Name>,
        at: u64,
        writes: u64,
    ) -> Result<Head, StoreError> {
        self.events
            .borrow_mut()
            .push((self.inner.gateway_id().to_owned(), "head", Some(*name)));
        self.inner.set_head(name, prev, at, writes)
    }
    fn snapshots(&self) -> Result<Vec<SnapshotEntry>, StoreError> {
        self.inner.snapshots()
    }
    fn list(&self, after: Option<&Name>, limit: usize) -> Result<Vec<ObjectEntry>, StoreError> {
        self.inner.list(after, limit)
    }
    fn delete(&self, names: &[Name], head_root: Option<&Name>) -> Result<Deleted, StoreError> {
        self.inner.delete(names, head_root)
    }
    fn held(&self, after: Option<&Name>, limit: usize) -> Result<Vec<HeldEntry>, StoreError> {
        self.inner.held(after, limit)
    }
    fn undo(&self, names: Option<&[Name]>) -> Result<u64, StoreError> {
        self.inner.undo(names)
    }
}

#[test]
fn records_of_every_gateway_go_before_thumbnails_of_any_before_originals_of_any() {
    let rig = Rig::new("classes");
    rig.grow(30, "classes");
    photos(&rig, 4);
    let events = Rc::new(RefCell::new(Vec::new()));
    let (one, two) = (MemoryStore::new("one"), MemoryStore::new("two"));
    for store in [&one, &two] {
        store.set_clock_ms(T0 * 2);
        rig.pair(store);
    }
    let taken = rig.snapshot(T0);
    let (a, b) = (
        Observed {
            inner: one.clone(),
            events: Rc::clone(&events),
        },
        Observed {
            inner: two.clone(),
            events: Rc::clone(&events),
        },
    );
    let env = rig.env(T0);
    let passes = vec![
        GatewayPass::new(&env, &a).expect("a pass"),
        GatewayPass::new(&env, &b).expect("a pass"),
    ];
    let mut scheduler = Scheduler::new(passes, 8);
    scheduler.run(10_000).expect("runs");

    let records = tree::records_of(&rig.state, &taken.root).expect("records");
    let thumbs = tree::media_of(&rig.state, &taken.root, Class::Thumbnails).expect("thumbs");
    let class_of = |name: &Name| {
        if records.contains_key(name) {
            0
        } else if thumbs.contains_key(name) {
            1
        } else {
            2
        }
    };
    let sequence: Vec<(String, u8)> = events
        .borrow()
        .iter()
        .map(|(gateway, kind, name)| {
            let class = match *kind {
                "head" => 0,
                _ => class_of(&name.expect("a frame")),
            };
            (gateway.clone(), class)
        })
        .collect();
    let classes: Vec<u8> = sequence.iter().map(|(_, class)| *class).collect();
    assert!(
        classes.windows(2).all(|pair| pair[0] <= pair[1]),
        "by class: {classes:?}"
    );
    // Round robin inside the records class: the two gateways alternate.
    let records_turns: Vec<&str> = sequence
        .iter()
        .filter(|(_, class)| *class == 0)
        .map(|(gateway, _)| gateway.as_str())
        .collect();
    assert!(
        records_turns.windows(2).any(|pair| pair[0] != pair[1]),
        "both are served: {records_turns:?}"
    );
    for store in [&one, &two] {
        assert_eq!(
            store.head().expect("head").expect("set").name,
            taken.root.name
        );
    }
}

#[test]
fn a_chunk_is_read_and_sealed_once_for_every_gateway_that_owes_it() {
    let rig = Rig::new("once");
    photos(&rig, 3);
    let (one, two) = (MemoryStore::new("one"), MemoryStore::new("two"));
    for store in [&one, &two] {
        store.set_clock_ms(T0 * 2);
        rig.pair(store);
    }
    rig.snapshot(T0);
    let env = rig.env(T0);
    let passes = vec![
        GatewayPass::new(&env, &one).expect("a pass"),
        GatewayPass::new(&env, &two).expect("a pass"),
    ];
    // One window for the whole run.
    let mut scheduler = Scheduler::new(passes, 10_000);
    scheduler.run(10_000).expect("runs");
    // 3 originals and 3 thumbnails, one chunk each.
    assert_eq!(
        env.source_reads(),
        6,
        "not 12: the second gateway is served from the window"
    );
    assert_eq!(one.stored_puts(), two.stored_puts());
}

#[test]
fn thumbnails_go_newest_first() {
    let rig = Rig::new("newest");
    photos(&rig, 5);
    let events = Rc::new(RefCell::new(Vec::new()));
    let store = MemoryStore::new("desk");
    store.set_clock_ms(T0 * 2);
    rig.pair(&store);
    let taken = rig.snapshot(T0);
    let observed = Observed {
        inner: store.clone(),
        events: Rc::clone(&events),
    };
    let env = rig.env(T0);
    let mut pass = GatewayPass::new(&env, &observed).expect("a pass");
    while matches!(pass.step().expect("steps"), Step::Worked | Step::Restarted) {}
    let root = tree::root_of(&rig.state, &taken.root).expect("root");
    let mut entries = tree::entries_of(&rig.state, &root.blobs).expect("entries");
    entries.retain(|entry| !entry.thumbnail.is_empty());
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.taken_at_ms));
    let wanted: Vec<Name> = entries
        .iter()
        .map(|entry| entry.thumbnail[0].name)
        .collect();
    // The thumbnail bundle is one bundle in this size; read what the gateway holds in the order
    // frames were handed over by checking the order in which names were *stored*: the store lists
    // by name, so compare the first frame of the thumbnail bundle instead.
    let thumbs_first = events
        .borrow()
        .iter()
        .filter_map(|(_, kind, name)| (*kind == "bundle").then_some(*name).flatten())
        .find(|name| wanted.contains(name))
        .expect("a thumbnail bundle");
    assert_eq!(thumbs_first, wanted[0], "the newest thumbnail leads");
}

#[test]
fn nothing_an_os_reports_marks_anything_stored() {
    let rig = Rig::new("os");
    photos(&rig, 2);
    let (store, root) = front(&rig);
    let env = rig.env(T0);
    let mut pass = GatewayPass::new(&env, &store).expect("a pass");
    let originals: Vec<Name> = tree::media_of(&rig.state, &root, Class::Originals)
        .expect("media")
        .into_keys()
        .collect();
    pass.os_reported(&originals);
    while matches!(pass.step().expect("steps"), Step::Worked | Step::Restarted) {}
    for name in &originals {
        assert!(
            store.has_bytes(name),
            "the report changed nothing: the engine still sent it"
        );
    }
    assert!(
        engine::standing(&rig.state, store.gateway_id())
            .expect("standing")
            .originals
    );
    assert!(engine::os_event_wakes_a_pass());
}

#[test]
fn a_gateway_that_loses_the_head_while_media_goes_up_restarts_the_pass() {
    let rig = Rig::new("headmoves");
    photos(&rig, 3);
    let (store, root) = front(&rig);
    let early = store.checkpoint();
    let env = rig.env(T0);
    let mut pass = GatewayPass::new(&env, &store).expect("a pass");
    while !pass.past_records() {
        pass.step().expect("steps");
    }
    assert_eq!(store.head().expect("head").expect("set").name, root.name);
    store.roll_back(&early);
    assert!(matches!(
        pass.recheck_head().expect("rechecks"),
        Step::Restarted
    ));
    assert_eq!(head_recheck_every(1, 8), 4);
    assert_eq!(head_recheck_every(20, 4), 10);
    while matches!(pass.step().expect("steps"), Step::Worked | Step::Restarted) {}
    assert_eq!(store.head().expect("head").expect("set").name, root.name);
    assert!(pass.stats.exists_calls > 0, "the restart was a recovery");
}

#[test]
fn read_back_finds_a_rotten_chunk_withdraws_the_claims_and_the_next_pass_mends_it() {
    let rig = Rig::new("rot");
    rig.grow(20, "rot");
    photos(&rig, 2);
    let (store, root) = front(&rig);
    run(&rig, &[&store], Policy::WIFI, T0);
    let victim = *tree::media_of(&rig.state, &root, Class::Originals)
        .expect("media")
        .keys()
        .next()
        .expect("an original");
    assert!(store.flip_bit(&victim));

    let env = rig.env(T0 + 10);
    let report = engine::read_back(&env, &store).expect("reads back");
    assert!(
        report.damaged.contains(&victim),
        "the walk reads every name in a few passes"
    );
    let withdrawn = gateway(&rig, &store);
    assert!(withdrawn.conf.is_none() && withdrawn.troot.is_none() && withdrawn.oroot.is_none());
    assert!(
        !engine::standing(&rig.state, store.gateway_id())
            .expect("standing")
            .originals
    );

    // The gateway marked it damaged: `exists` lists it, a delete frees it, a resend mends it.
    let stats = run(&rig, &[&store], Policy::WIFI, T0 + 20);
    assert!(stats[0].freed >= 1 || store.exists(&[victim]).expect("exists").is_empty());
    assert!(
        store.exists(&[victim]).expect("exists").is_empty(),
        "held whole again"
    );
    assert!(
        engine::standing(&rig.state, store.gateway_id())
            .expect("standing")
            .originals
    );
}

#[test]
fn the_members_rule_decides_which_class_crosses_which_link() {
    let metered = |photos_on_cellular, asked| Policy {
        link: Link::Metered,
        photos_on_cellular,
        asked,
    };
    assert!(Policy::WIFI.allows(Class::Originals, true));
    assert!(
        !metered(false, false).allows(Class::Records, false),
        "Wi-Fi only by default"
    );
    assert!(
        metered(false, true).allows(Class::Records, false),
        "Back up now sends records"
    );
    assert!(
        !metered(false, true).allows(Class::Originals, false),
        "never a heavy original"
    );
    assert!(!metered(false, true).allows(Class::Thumbnails, false));
    assert!(metered(true, false).allows(Class::Thumbnails, false));
    assert!(
        metered(true, false).allows(Class::Originals, false),
        "photos, when the member says"
    );
    assert!(
        !metered(true, false).allows(Class::Originals, true),
        "a video original never"
    );
}

#[test]
fn on_a_metered_link_with_the_default_rule_nothing_moves() {
    let rig = Rig::new("metered");
    photos(&rig, 2);
    let (store, _) = front(&rig);
    let policy = Policy {
        link: Link::Metered,
        photos_on_cellular: false,
        asked: false,
    };
    let env = Env::new(rig.vault(), &rig.keys, &rig.state, &rig.staging, policy, T0);
    let mut scheduler = Scheduler::new(vec![GatewayPass::new(&env, &store).expect("a pass")], 8);
    assert_eq!(scheduler.run(100).expect("runs"), 0);
    assert_eq!(store.counts().frames, 0);
    // "Back up now": records go, a thumbnail does not.
    let asked = Policy {
        asked: true,
        ..policy
    };
    let env = Env::new(rig.vault(), &rig.keys, &rig.state, &rig.staging, asked, T0);
    let mut scheduler = Scheduler::new(vec![GatewayPass::new(&env, &store).expect("a pass")], 8);
    scheduler.run(1_000).expect("runs");
    let gateway = gateway(&rig, &store);
    assert!(gateway.conf.is_some());
    assert!(gateway.troot.is_none() && gateway.oroot.is_none());
}

#[test]
fn a_photo_is_held_whole_only_when_every_chunk_is_reachable_from_oroot() {
    let rig = Rig::new("whole");
    let big = rig.add_original(&[7_u8; 100]);
    let (store, _) = front(&rig);
    let env = rig.env(T0);
    assert!(
        !engine::held_whole(&env, store.gateway_id(), &big).expect("asks"),
        "nothing yet"
    );
    run(&rig, &[&store], Policy::WIFI, T0);
    assert!(engine::held_whole(&env, store.gateway_id(), &big).expect("asks"));
    assert_eq!(
        engine::holders(&env, &big).expect("holders"),
        vec![store.gateway_id().to_owned()]
    );
}

#[test]
fn the_commit_rule_is_asserted_when_a_gateway_leaves_a_frame_unanswered() {
    struct Forgetful(MemoryStore);
    impl Store for Forgetful {
        fn gateway_id(&self) -> &str {
            self.0.gateway_id()
        }
        fn exists(&self, names: &[Name]) -> Result<Vec<Name>, StoreError> {
            self.0.exists(names)
        }
        fn bundle(&self, parts: &[Outgoing]) -> Result<Vec<(Name, FrameAnswer)>, StoreError> {
            let mut answers = self.0.bundle(parts)?;
            answers.pop();
            Ok(answers)
        }
        fn get(&self, name: &Name, sink: &mut dyn std::io::Write) -> Result<u64, StoreError> {
            self.0.get(name, sink)
        }
        fn head(&self) -> Result<Option<Head>, StoreError> {
            self.0.head()
        }
        fn set_head(
            &self,
            name: &Name,
            prev: Option<&Name>,
            at: u64,
            writes: u64,
        ) -> Result<Head, StoreError> {
            self.0.set_head(name, prev, at, writes)
        }
        fn snapshots(&self) -> Result<Vec<SnapshotEntry>, StoreError> {
            self.0.snapshots()
        }
        fn list(&self, after: Option<&Name>, limit: usize) -> Result<Vec<ObjectEntry>, StoreError> {
            self.0.list(after, limit)
        }
        fn delete(&self, names: &[Name], head_root: Option<&Name>) -> Result<Deleted, StoreError> {
            self.0.delete(names, head_root)
        }
        fn held(&self, after: Option<&Name>, limit: usize) -> Result<Vec<HeldEntry>, StoreError> {
            self.0.held(after, limit)
        }
        fn undo(&self, names: Option<&[Name]>) -> Result<u64, StoreError> {
            self.0.undo(names)
        }
    }
    let rig = Rig::new("rule");
    rig.grow(10, "rule");
    let store = MemoryStore::new("desk");
    store.set_clock_ms(T0 * 2);
    rig.pair(&store);
    rig.snapshot(T0);
    let forgetful = Forgetful(store.clone());
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let env = rig.env(T0);
        let mut pass = GatewayPass::new(&env, &forgetful).expect("a pass");
        loop {
            match pass.step() {
                Ok(Step::Worked | Step::Restarted) => {}
                other => return format!("{other:?}"),
            }
        }
    }));
    assert!(
        outcome.is_err(),
        "a debug build panics on a commit-rule violation"
    );
    assert!(
        store.head().expect("head").is_none(),
        "and the head was not set"
    );
}

#[test]
fn collection_deletes_what_no_kept_root_reaches_and_never_a_reachable_name() {
    let rig = Rig::new("collect");
    rig.grow(20, "collect");
    photos(&rig, 2);
    let store = MemoryStore::new("desk");
    store.set_clock_ms(T0 * 4);
    rig.pair(&store);
    let day = 24 * 60 * 60 * 1000;
    // Sixteen weeks of daily-ish snapshots, each with a changed vault: more than retention keeps.
    let mut roots = Vec::new();
    for n in 0..24_u64 {
        rig.raw()
            .execute("UPDATE vault SET writes = writes + 1", [])
            .expect("an edit");
        let taken = rig.snapshot(T0 + n * 5 * day);
        run(&rig, &[&store], Policy::WIFI, T0 + n * 5 * day);
        roots.push(taken.root);
    }
    let snapshots = store.snapshots().expect("snapshots");
    assert_eq!(snapshots.len(), 24);
    let kept = retention::keep(&snapshots);
    assert!(
        kept.len() < 24 && kept.contains(&roots[23].name),
        "the newest is kept"
    );

    let env = rig.env(T0 + 24 * 5 * day);
    let listing_before: BTreeSet<Name> =
        store.contents().into_iter().map(|(name, _)| name).collect();
    let outcome = retention::collect(&env, &store).expect("collects");
    let Collected::Done { deleted, .. } = outcome else {
        panic!("collection stopped: {outcome:?}");
    };
    assert!(deleted > 0, "old snapshots' objects are garbage");
    let held: BTreeSet<Name> = store
        .held(None, 1000)
        .expect("held")
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    assert_eq!(held.len(), deleted);
    // Nothing a kept root, the head or a claimed root reaches was deleted.
    for root in roots.iter().filter(|root| kept.contains(&root.name)) {
        for name in tree::everything_of(&rig.state, root).expect("names") {
            assert!(!held.contains(&name), "a kept snapshot's name was deleted");
        }
    }
    let head = store.head().expect("head").expect("set").name;
    assert!(!held.contains(&head));
    let after: BTreeSet<Name> = store
        .exists(&listing_before.iter().copied().collect::<Vec<_>>())
        .expect("exists")
        .into_iter()
        .collect();
    assert_eq!(
        after.len(),
        deleted,
        "exactly the held ones are missing now"
    );
}

#[test]
fn collection_stops_in_doubt_when_a_kept_root_will_not_open() {
    let rig = Rig::new("doubt");
    rig.grow(10, "doubt");
    let store = MemoryStore::new("desk");
    store.set_clock_ms(T0 * 4);
    rig.pair(&store);
    let first = rig.snapshot(T0);
    run(&rig, &[&store], Policy::WIFI, T0);
    rig.raw()
        .execute("UPDATE vault SET writes = writes + 1", [])
        .expect("an edit");
    let day = 24 * 60 * 60 * 1000;
    rig.snapshot(T0 + 2 * day);
    run(&rig, &[&store], Policy::WIFI, T0 + 2 * day);
    // The first root is kept (the newest of its day), and its copy rots on the gateway while the
    // phone's node cache no longer holds it.
    assert!(store.flip_bit(&first.root.name));
    let cached = rig.state.get_node(&first.root.name).expect("reads");
    assert!(cached.is_some());
    rig.state
        .forget_nodes_except(&[].into_iter().collect())
        .expect("forgets all");
    let env = rig.env(T0 + 3 * day);
    let before = store.counts().deletes;
    let outcome = retention::collect(&env, &store).expect("collects");
    assert!(matches!(outcome, Collected::Doubt(_)), "{outcome:?}");
    assert_eq!(store.counts().deletes, before, "doubt never deletes");
}

#[test]
fn a_member_who_undid_a_delete_keeps_those_names_for_a_week() {
    let rig = Rig::new("undo");
    rig.grow(10, "undo");
    photos(&rig, 1);
    let (store, _) = front(&rig);
    run(&rig, &[&store], Policy::WIFI, T0);
    // A stray name nothing reaches is garbage; the member's Undo of it keeps it.
    let stray = {
        let sealed =
            centraid_media::sealed::seal(&rig.keys, Class::Records, b"stray").expect("seals");
        store
            .bundle(&[Outgoing::of(sealed.name, sealed.object)])
            .expect("sent");
        sealed.name
    };
    let env = rig.env(T0);
    store
        .delete(
            &[stray],
            store.head().expect("head").map(|head| head.name).as_ref(),
        )
        .expect("deleted");
    retention::undo(&env, &store, &[stray]).expect("undone");
    let outcome = retention::collect(&env, &store).expect("collects");
    assert!(
        matches!(outcome, Collected::Done { deleted: 0, .. }),
        "{outcome:?}"
    );
    assert!(store.exists(&[stray]).expect("exists").is_empty());
    let later = rig.env(T0 + 8 * 24 * 60 * 60 * 1000);
    let outcome = retention::collect(&later, &store).expect("collects");
    assert!(
        matches!(outcome, Collected::Done { deleted: 1, .. }),
        "a week on it is garbage again"
    );
}

#[test]
fn os_bundles_are_at_most_four_files_of_at_most_32_mib() {
    let rig = Rig::new("osbundles");
    photos(&rig, 6);
    let (store, _) = front(&rig);
    let env = rig.env(T0);
    let bundles = engine::write_os_bundles(&env, &store, Class::Originals).expect("writes");
    assert!(!bundles.is_empty() && bundles.len() <= engine::OS_BUNDLES);
    assert!(
        bundles
            .iter()
            .all(|bundle| bundle.bytes <= engine::OS_BUNDLE_BYTES)
    );
    let listed: usize = bundles.iter().map(|bundle| bundle.names.len()).sum();
    assert_eq!(listed, 6, "every owed original is in a file");
    // A file is the gateway's own bundle framing, so the shell can upload it as it is.
    let body = std::fs::read(&bundles[0].path).expect("reads");
    let frames = centraid_gateway::rules::bundle::decode(&body).expect("decodes");
    assert_eq!(frames.len(), bundles[0].names.len());
}

#[test]
fn retention_keeps_seven_daily_four_weekly_six_monthly_and_always_the_newest() {
    const DAY: u64 = 24 * 60 * 60 * 1000;
    let snapshot = |day: u64, held: bool| SnapshotEntry {
        name: Name::from_bytes([u8::try_from(day).expect("a byte"); 32]),
        taken_at_ms: T0 + day * DAY,
        registered_at_ms: T0 + day * DAY,
        epoch: 1,
        generation: day,
        held_at_ms: held.then_some(T0),
        purge_after_ms: held.then_some(T0 + 7 * DAY),
    };
    // Names are one byte of the day, so keep the history under 256 days of distinct names.
    let entries: Vec<SnapshotEntry> = (0..250).map(|day| snapshot(day, false)).collect();
    let kept = retention::keep(&entries);
    let day_of = |name: &Name| u64::from(name.as_bytes()[0]);
    let kept_days: BTreeSet<u64> = kept.iter().map(day_of).collect();
    assert!(kept_days.contains(&249), "the newest is always kept");
    for day in 243..250 {
        assert!(
            kept_days.contains(&day),
            "the last seven days are kept: {day}"
        );
    }
    assert!(
        (7..=17).contains(&kept.len()),
        "7 daily + 4 weekly + 6 monthly, overlapping: {}",
        kept.len()
    );
    assert!(
        kept_days.iter().all(|day| *day >= 60),
        "nothing older than the sixth month back: {kept_days:?}"
    );
    assert!(
        kept_days.iter().any(|day| (60..243).contains(day)),
        "weekly and monthly reach back"
    );

    // A snapshot already held for deletion is never kept, even as the newest.
    let mut with_held = entries;
    with_held.push(snapshot(250, true));
    let kept = retention::keep(&with_held);
    assert!(!kept.contains(&Name::from_bytes([250; 32])));
    assert!(
        kept.contains(&Name::from_bytes([249; 32])),
        "the newest that is not held stands"
    );
}

struct RefusingStore {
    inner: MemoryStore,
    head_err: Option<centraid_vault::backup::store::Refusal>,
    bundle_err: Option<centraid_vault::backup::store::Refusal>,
}

impl Store for RefusingStore {
    fn gateway_id(&self) -> &str {
        self.inner.gateway_id()
    }
    fn exists(&self, names: &[Name]) -> Result<Vec<Name>, StoreError> {
        self.inner.exists(names)
    }
    fn bundle(&self, parts: &[Outgoing]) -> Result<Vec<(Name, FrameAnswer)>, StoreError> {
        if let Some(refusal) = &self.bundle_err {
            return Err(StoreError::Refused(refusal.clone()));
        }
        self.inner.bundle(parts)
    }
    fn get(&self, name: &Name, sink: &mut dyn std::io::Write) -> Result<u64, StoreError> {
        self.inner.get(name, sink)
    }
    fn check_name(&self, name: &Name) -> Result<NameCheck, StoreError> {
        self.inner.check_name(name)
    }
    fn head(&self) -> Result<Option<Head>, StoreError> {
        if let Some(refusal) = &self.head_err {
            return Err(StoreError::Refused(refusal.clone()));
        }
        self.inner.head()
    }
    fn generation(&self) -> u64 {
        self.inner.generation()
    }
    fn set_head(
        &self,
        name: &Name,
        prev: Option<&Name>,
        at: u64,
        writes: u64,
    ) -> Result<Head, StoreError> {
        self.inner.set_head(name, prev, at, writes)
    }
    fn snapshots(&self) -> Result<Vec<SnapshotEntry>, StoreError> {
        self.inner.snapshots()
    }
    fn list(&self, after: Option<&Name>, limit: usize) -> Result<Vec<ObjectEntry>, StoreError> {
        self.inner.list(after, limit)
    }
    fn delete(&self, names: &[Name], head_root: Option<&Name>) -> Result<Deleted, StoreError> {
        self.inner.delete(names, head_root)
    }
    fn held(&self, after: Option<&Name>, limit: usize) -> Result<Vec<HeldEntry>, StoreError> {
        self.inner.held(after, limit)
    }
    fn undo(&self, names: Option<&[Name]>) -> Result<u64, StoreError> {
        self.inner.undo(names)
    }
}

#[test]
fn unauthorized_stops_with_pair_again_and_persists_reach_pair_again() {
    use centraid_vault::backup::engine::Stop;
    use centraid_vault::backup::state::Reach;
    use centraid_vault::backup::store::Refusal;

    let rig = Rig::new("unauth");
    rig.grow(5, "unauth");
    let (inner, _) = front(&rig);
    let store = RefusingStore {
        inner,
        head_err: Some(Refusal::Unauthorized),
        bundle_err: None,
    };
    let env = rig.env(T0);
    let mut pass = GatewayPass::new(&env, &store).expect("a pass");
    let step = pass.step().expect("steps");
    assert_eq!(step, Step::Stopped(Stop::PairAgain));
    assert_eq!(pass.stop_reason(), Some(&Stop::PairAgain));
    let row = rig
        .state
        .gateway(store.gateway_id())
        .expect("reads")
        .expect("paired");
    assert_eq!(
        row.reach,
        Reach::PairAgain,
        "401 Unauthorized must persist Reach::PairAgain on the gateway row"
    );
}

#[test]
fn full_and_restage_do_not_persist_reach_unreachable() {
    use centraid_vault::backup::engine::Stop;
    use centraid_vault::backup::state::Reach;
    use centraid_vault::backup::store::Refusal;

    // 1. Stop::Full must leave Reach::Ok intact (the gateway answered, its disk is full).
    let rig_full = Rig::new("full_reach");
    rig_full.grow(5, "full_reach");
    let (inner, _) = front(&rig_full);
    let store = RefusingStore {
        inner,
        head_err: None,
        bundle_err: Some(Refusal::DiskFull),
    };
    let env = rig_full.env(T0);
    let mut pass = GatewayPass::new(&env, &store).expect("a pass");
    loop {
        match pass.step().expect("steps") {
            Step::Worked | Step::Restarted => {}
            Step::Stopped(stop) => {
                assert_eq!(stop, Stop::Full);
                break;
            }
            Step::Done => panic!("expected Stop::Full"),
        }
    }
    let row = rig_full
        .state
        .gateway(store.gateway_id())
        .expect("reads")
        .expect("paired");
    assert_eq!(
        row.reach,
        Reach::Ok,
        "Stop::Full must not overwrite Reach::Ok with Reach::Unreachable"
    );

    // 2. Stop::Restage must leave Reach::Ok intact (staging miss is local, not unreachable).
    let rig_restage = Rig::new("restage_reach");
    rig_restage.grow(5, "restage_reach");
    let (store, _) = front(&rig_restage);
    for name in rig_restage.staging.names().expect("names") {
        rig_restage.staging.release(&name).expect("release");
    }
    let env = rig_restage.env(T0);
    let mut pass = GatewayPass::new(&env, &store).expect("a pass");
    loop {
        match pass.step().expect("steps") {
            Step::Worked | Step::Restarted => {}
            Step::Stopped(stop) => {
                assert_eq!(stop, Stop::Restage);
                break;
            }
            Step::Done => panic!("expected Stop::Restage"),
        }
    }
    let row = gateway(&rig_restage, &store);
    assert_eq!(
        row.reach,
        Reach::Ok,
        "Stop::Restage must not overwrite Reach::Ok with Reach::Unreachable"
    );
}

struct TruncatingStore {
    inner: MemoryStore,
    /// Number of multi-frame bundle calls left to truncate to a single frame.
    truncate_left: std::cell::Cell<usize>,
}

impl Store for TruncatingStore {
    fn gateway_id(&self) -> &str {
        self.inner.gateway_id()
    }
    fn exists(&self, names: &[Name]) -> Result<Vec<Name>, StoreError> {
        self.inner.exists(names)
    }
    fn bundle(&self, parts: &[Outgoing]) -> Result<Vec<(Name, FrameAnswer)>, StoreError> {
        let left = self.truncate_left.get();
        if left > 0 && parts.len() > 1 && self.inner.head()?.is_some() {
            self.truncate_left.set(left - 1);
            // Only store and answer the first frame; omit the rest from the response.
            return self.inner.bundle(&parts[..1]);
        }
        self.inner.bundle(parts)
    }
    fn get(&self, name: &Name, sink: &mut dyn std::io::Write) -> Result<u64, StoreError> {
        self.inner.get(name, sink)
    }
    fn check_name(&self, name: &Name) -> Result<NameCheck, StoreError> {
        self.inner.check_name(name)
    }
    fn head(&self) -> Result<Option<Head>, StoreError> {
        self.inner.head()
    }
    fn generation(&self) -> u64 {
        self.inner.generation()
    }
    fn set_head(
        &self,
        name: &Name,
        prev: Option<&Name>,
        at: u64,
        writes: u64,
    ) -> Result<Head, StoreError> {
        self.inner.set_head(name, prev, at, writes)
    }
    fn snapshots(&self) -> Result<Vec<SnapshotEntry>, StoreError> {
        self.inner.snapshots()
    }
    fn list(&self, after: Option<&Name>, limit: usize) -> Result<Vec<ObjectEntry>, StoreError> {
        self.inner.list(after, limit)
    }
    fn delete(&self, names: &[Name], head_root: Option<&Name>) -> Result<Deleted, StoreError> {
        self.inner.delete(names, head_root)
    }
    fn held(&self, after: Option<&Name>, limit: usize) -> Result<Vec<HeldEntry>, StoreError> {
        self.inner.held(after, limit)
    }
    fn undo(&self, names: Option<&[Name]>) -> Result<u64, StoreError> {
        self.inner.undo(names)
    }
}

#[test]
fn partial_bundle_response_retries_unanswered_frames() {
    let rig = Rig::new("partial_bundle");
    photos(&rig, 4);
    let (inner, taken) = front(&rig);
    let store = TruncatingStore {
        inner,
        // Truncate once during records and once during media (thumbnails/originals).
        truncate_left: std::cell::Cell::new(3),
    };
    let env = rig.env(T0);
    let mut pass = GatewayPass::new(&env, &store).expect("a pass");
    loop {
        match pass.step().expect("steps") {
            Step::Worked | Step::Restarted => {}
            Step::Done => break,
            Step::Stopped(stop) => panic!("unexpected stop: {stop:?}"),
        }
    }
    assert_eq!(
        store.truncate_left.get(),
        0,
        "all three truncated bundle responses should have been exercised"
    );
    let standing = engine::standing(&rig.state, store.gateway_id()).expect("standing");
    assert!(standing.records.is_some());
    assert!(standing.thumbnails);
    assert!(standing.originals);

    // Every single record, thumbnail, and original chunk in the tree must actually be present
    // in the store — none silently dropped by the truncated bundle responses.
    let mut expected: Vec<Name> = tree::records_of(&rig.state, &taken)
        .expect("records")
        .into_keys()
        .collect();
    expected.extend(
        tree::media_of(&rig.state, &taken, Class::Thumbnails)
            .expect("thumbs")
            .into_keys(),
    );
    expected.extend(
        tree::media_of(&rig.state, &taken, Class::Originals)
            .expect("originals")
            .into_keys(),
    );
    let missing = store.inner.exists(&expected).expect("exists");
    assert!(
        missing.is_empty(),
        "unanswered frames must be retried, not silently dropped; missing: {}",
        missing.len()
    );
}

#[test]
fn unstreamed_os_original_blocks_oroot_confirmation_until_streamed() {
    let rig = Rig::new("unstreamed_os");
    rig.grow(5, "unstreamed_os");
    // A thumbnail exists locally, while the OS-library original is claimed in SQLite without bytes
    // in BlobStore or blob_chunk/os_chunk yet.
    let os_bytes = b"os-library original photo bytes that arrive later".repeat(40);
    let os_hash = centraid_media::sealed::PlaintextHash::of(&os_bytes);
    rig.vault()
        .commit(|tx| {
            tx.connection().execute(
                "INSERT INTO blob (hash, size) VALUES (?1, ?2)",
                centraid_vault::rusqlite::params![os_hash.to_hex(), os_bytes.len() as i64],
            )?;
            Ok(())
        })
        .expect("claims unstreamed os blob");
    rig.add_thumbnail(&os_hash, b"thumb bytes", "2026-04-01T00:00:00.000Z");

    let (store, root) = front(&rig);
    let root_node = tree::root_of(&rig.state, &root).expect("root");
    let stats = tree::stats_of(&rig.state, &root_node.blobs).expect("stats");
    assert_eq!(stats.unheld_orig_files, 1);
    assert_eq!(stats.unheld_thumb_files, 0);

    let pass_stats = run(&rig, &[&store], Policy::WIFI, T0);
    assert!(pass_stats[0].waiting >= 1);
    let gw = gateway(&rig, &store);
    assert_eq!(gw.conf.map(|(n, _)| n), Some(root.name));
    assert_eq!(gw.troot.map(|(n, _)| n), Some(root.name));
    assert_eq!(
        gw.oroot, None,
        "oroot must never confirm while an in-scope original lacks bytes"
    );
    let standing = engine::standing(&rig.state, store.gateway_id()).expect("standing");
    assert!(standing.records.is_some());
    assert!(standing.thumbnails);
    assert!(!standing.originals);

    // Now the OS library streams the original: seal chunk, stage it, record os_chunks, re-snapshot.
    let sealed =
        centraid_media::sealed::seal(&rig.keys, Class::Originals, &os_bytes).expect("seal");
    let staged_path = rig
        .staging
        .put(&sealed.name, &sealed.object)
        .expect("stage");
    rig.state
        .stage(
            &sealed.name,
            &staged_path.to_string_lossy(),
            sealed.object.len() as u64,
        )
        .expect("record stage");
    rig.state
        .put_os_chunks(&os_hash, &[sealed.reference()])
        .expect("record os_chunks");

    let next = rig.snapshot(T0 + 1_000);
    let next_root = tree::root_of(&rig.state, &next.root).expect("next root");
    let next_stats = tree::stats_of(&rig.state, &next_root.blobs).expect("next stats");
    assert_eq!(next_stats.unheld_orig_files, 0);

    run(&rig, &[&store], Policy::WIFI, T0 + 1_000);
    let gw = gateway(&rig, &store);
    assert_eq!(gw.oroot.map(|(n, _)| n), Some(next.root.name));
    assert!(
        engine::standing(&rig.state, store.gateway_id())
            .expect("standing")
            .originals
    );
    assert!(store.has_bytes(&sealed.name));
}

#[test]
fn peer_gateway_repairs_cloud_only_original_to_newly_paired_gateway() {
    let rig = Rig::new("peer_repair");
    rig.grow(5, "peer_repair");
    let raw_bytes = b"cloud-only photo original ".repeat(300);
    let orig_hash = rig.add_original(&raw_bytes);
    rig.add_thumbnail(&orig_hash, b"thumb", "2026-04-02T00:00:00.000Z");

    let store_a = MemoryStore::new("gw-a");
    store_a.set_clock_ms(T0 * 2);
    rig.pair(&store_a);
    let taken = rig.snapshot(T0);
    run(&rig, &[&store_a], Policy::WIFI, T0);
    assert!(
        engine::standing(&rig.state, store_a.gateway_id())
            .expect("standing")
            .originals
    );

    // Simulate "Free up space": delete the local file from BlobStore (and drop any staged copy).
    assert!(
        rig.vault()
            .blobs()
            .expect("blobs")
            .remove(&orig_hash.to_hex())
            .expect("removes local blob")
    );
    for name in rig.staging.names().expect("staged names") {
        rig.staging.release(&name).expect("release");
    }

    // Pair a second gateway and run a pass with store_a passed as a peer.
    let store_b = MemoryStore::new("gw-b");
    store_b.set_clock_ms(T0 * 2);
    rig.pair(&store_b);
    let env = Env::new(
        rig.vault(),
        &rig.keys,
        &rig.state,
        &rig.staging,
        Policy::WIFI,
        T0 + 1_000,
    )
    .with_peers(vec![&store_a as &dyn Store]);
    let mut pass = GatewayPass::new(&env, &store_b).expect("pass");
    while matches!(pass.step().expect("steps"), Step::Worked | Step::Restarted) {}
    assert!(pass.is_over() && pass.stop_reason().is_none());
    assert_eq!(
        gateway(&rig, &store_b).oroot.map(|(n, _)| n),
        Some(taken.root.name)
    );
    assert!(
        engine::standing(&rig.state, store_b.gateway_id())
            .expect("standing")
            .originals
    );

    // Restore the original from store_b alone and verify the exact plaintext bytes come back.
    let restore =
        centraid_vault::backup::restore::Restore::open(&rig.keys, &[&store_b], &taken.root.name)
            .expect("restore opens from store_b");
    let mut restored_orig = None;
    let report = restore
        .originals(&mut |entry, bytes| {
            if entry.h == orig_hash {
                restored_orig = Some(bytes.to_vec());
            }
            Ok(())
        })
        .expect("restores originals");
    assert_eq!(report.restored, 1);
    assert_eq!(restored_orig.as_deref(), Some(raw_bytes.as_slice()));
}

#[test]
fn retention_collect_visits_shared_blobs_subtrees_once_across_kept_snapshots() {
    let rig = Rig::new("memo_collect");
    rig.grow(10, "memo_collect");
    photos(&rig, 4);
    let store = MemoryStore::new("desk");
    store.set_clock_ms(T0 * 4);
    rig.pair(&store);
    let day = 24 * 60 * 60 * 1000;

    let mut roots = Vec::new();
    for n in 0..5_u64 {
        rig.raw()
            .execute("UPDATE vault SET writes = writes + 1", [])
            .expect("one page edit");
        let taken = rig.snapshot(T0 + n * day);
        run(&rig, &[&store], Policy::WIFI, T0 + n * day);
        roots.push(taken.root);
    }

    // Counting Store wrapper on `get`: clear cached subtrees (except roots? or clear all nodes so
    // Fetching reads from the store and caches into `state`). Because `Fetching` populates `state`
    // on first miss, count `NodeSource::plaintext` calls via `CountingSource` on `retention::reachable`,
    // AND verify `retention::collect` succeeds with memoized shared blobs subtree!
    struct CountingSource<'a> {
        inner: &'a dyn tree::NodeSource,
        reads: std::cell::RefCell<std::collections::BTreeMap<Name, usize>>,
    }
    impl tree::NodeSource for CountingSource<'_> {
        fn plaintext(&self, name: &Name) -> centraid_vault::backup::Result<Option<Vec<u8>>> {
            *self.reads.borrow_mut().entry(*name).or_insert(0) += 1;
            self.inner.plaintext(name)
        }
    }

    let source = CountingSource {
        inner: &rig.state,
        reads: std::cell::RefCell::new(std::collections::BTreeMap::new()),
    };
    let reached = retention::reachable(&source, &roots).expect("reachable");
    let shared_blobs = tree::root_of(&rig.state, &roots[0]).expect("root0").blobs;
    assert_eq!(
        source.reads.borrow().get(&shared_blobs.name).copied(),
        Some(1),
        "shared blobs root across all 5 kept snapshots must be decoded once"
    );
    assert!(reached.contains_key(&shared_blobs.name));

    let env = rig.env(T0 + 6 * day);
    let outcome = retention::collect(&env, &store).expect("collects");
    assert!(matches!(outcome, Collected::Done { .. }));
}
