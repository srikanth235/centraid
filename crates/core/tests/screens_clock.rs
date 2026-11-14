//! Screen time is the mounted vault's injected clock, never a second wall clock.

use std::path::Path;
use std::sync::{Arc, Mutex};

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::ScreenCtx;
use centraid_core::vaults::{HeldVault, Vaults};
use centraid_core::{Core, CoreConfig, Handle, ShelfConfig};
use centraid_vault::Clock;
use centraid_vault::clock::{ClockIds, FixedClock};

fn clocked(path: &Path, clock: Arc<FixedClock>) -> Handle {
    Core::open(
        CoreConfig::new(path).with_clock(clock.clone(), Arc::new(ClockIds::new(Box::new(clock)))),
    )
    .expect("a clocked core opens")
}

#[test]
fn a_direct_screen_reads_the_injected_clock_and_a_closed_core_is_unready() {
    let dir = tempfile::tempdir().expect("a directory");
    let clock = Arc::new(FixedClock::frozen());
    let core = clocked(&dir.path().join("vault.db"), clock.clone());
    assert_eq!(core.now_ms(), Some(clock.now_ms()));
    clock.advance_ms(37);
    assert_eq!(core.now_ms(), Some(clock.now_ms()));
    core.close();
    assert_eq!(core.now_ms(), None);
}

struct Front(Mutex<Option<Handle>>);

impl Vaults for Front {
    fn foreground_id(&self) -> Option<String> {
        self.foreground_core().map(|_| "front".to_owned())
    }

    fn foreground_core(&self) -> Option<Handle> {
        self.0.lock().expect("front lock").clone()
    }

    fn held(&self) -> Vec<HeldVault> {
        Vec::new()
    }

    fn core_of(&self, _vault_id: &str) -> Option<Handle> {
        None
    }

    fn awake(&self) -> Vec<Handle> {
        self.foreground_core().into_iter().collect()
    }

    fn holdings(&self) -> wire::Holdings {
        wire::Holdings::default()
    }

    fn bring_to_front(&self, _vault_id: &str) -> bool {
        false
    }

    fn freeze(&self, _vault_id: &str, _at: &str, _unacked: u64) {}

    fn close_all(&self) {
        if let Some(front) = self.0.lock().expect("front lock").take() {
            front.close();
        }
    }
}

#[test]
fn a_shelf_has_no_clock_until_mounted_and_follows_the_current_vault() {
    let dir = tempfile::tempdir().expect("a directory");
    let shelf = Core::open(CoreConfig::fronting(ShelfConfig::new(
        dir.path().join("shelf"),
    )))
    .expect("a shelf core opens");
    assert_eq!(shelf.now_ms(), None);
    let mounted = Arc::new(Front(Mutex::new(None)));
    shelf.attach_vaults(mounted.clone());
    assert_eq!(shelf.now_ms(), None);

    let first_clock = Arc::new(FixedClock::frozen());
    let first = clocked(&dir.path().join("first.db"), first_clock.clone());
    *mounted.0.lock().expect("front lock") = Some(first.clone());
    assert_eq!(shelf.now_ms(), Some(first_clock.now_ms()));
    first_clock.advance_ms(91);
    assert_eq!(shelf.now_ms(), Some(first_clock.now_ms()));

    let second_clock = Arc::new(FixedClock::at(first_clock.now_ms() + 1_000));
    let second = clocked(&dir.path().join("second.db"), second_clock.clone());
    *mounted.0.lock().expect("front lock") = Some(second.clone());
    assert_eq!(shelf.now_ms(), Some(second_clock.now_ms()));
    first_clock.advance_ms(22);
    assert_eq!(shelf.now_ms(), Some(second_clock.now_ms()));
    *mounted.0.lock().expect("front lock") = None;
    assert_eq!(shelf.now_ms(), None);
    first.close();
    second.close();
    shelf.close();
}
