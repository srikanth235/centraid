use std::sync::Arc;

use centraid_screens::testing::Driver;
use centraid_vault::Clock;
use centraid_vault::clock::FixedClock;

#[test]
fn context_forwards_the_vault_clock_without_caching_an_instant() {
    let clock = Arc::new(FixedClock::frozen());
    let d = Driver::with_runtime_clocked(centraid_screens::docs::runtime(), clock.clone());
    d.with_ctx(|ctx| assert_eq!(ctx.now_ms(), Some(clock.now_ms())));
    clock.advance_ms(157);
    d.with_ctx(|ctx| assert_eq!(ctx.now_ms(), Some(clock.now_ms())));
}
