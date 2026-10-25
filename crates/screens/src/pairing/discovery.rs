//! FINDING A GATEWAY WHOSE ADDRESS CHANGED (#1080, Q-1080-D3, recommended (a)).
//!
//! The pairing payload's addresses are the only ones the core keeps. A gateway
//! that wakes on another address leaves the phone dialling a dead one and
//! reading "waiting for your backup device" until the member pairs again.
//! `serve` advertises `_centraid-gateway._tcp` with its id in the TXT record
//! (`gw`), so a phone in the foreground can ask the local network where that
//! gateway is now.
//!
//! ## Three parts, and where each one lives
//!
//! | Part | Lives in | Does |
//! |---|---|---|
//! | the browse | the shell (`NWBrowser` on iOS, `NsdManager` on Android), as `BrowseGateways` | finds advertisements and resolves their addresses |
//! | the match | [`super::matching`] | decides which sighting is WHICH gateway and which addresses may be offered |
//! | the check | the core's `refresh_destination` | dials each offered address with the pinned certificate and keeps only the ones that answer as that gateway |
//!
//! ## THE PHONE NEVER LISTENS
//!
//! A browse is a query and its answers: the phone sends a multicast question and
//! reads replies, which is an outbound act. It opens no listening socket and
//! accepts no connection. It runs in the FOREGROUND only, for seconds at a time,
//! and only for as long as the screen that asked wants it.
//!
//! [`Rediscovery`] is the piece a screen (the Backup screen, a pass service)
//! holds: it starts and stops the browse, matches each window's sightings to
//! the gateways the ledger records and asks the core to refresh the ones that
//! matched. Everything the member sees of it is the next pass reaching the
//! gateway; nothing is asked and nothing is drawn.

use centraid_api_proto::core_v1 as wire;

use super::{door, matching};
use crate::screen::Ctx;

/// A LAN answers in well under this; a member is looking at "waiting for your
/// backup device".
pub const BROWSE_MS: u32 = 4_000;

/// The least time between two windows while a browse is on, so an unreachable
/// gateway is not browsed for in a loop.
pub const MIN_INTERVAL_MS: u32 = 30_000;

/// The tag a refresh's off-thread answer comes back under; the gateway's id
/// follows.
const TAG_PREFIX: &str = "refresh:";

/// One foreground rediscovery, as a piece a screen holds.
#[derive(Debug, Default)]
pub struct Rediscovery {
    browsing: bool,
    /// Refreshes asked of the core and not yet answered.
    pending: usize,
    /// How many gateways the core kept new addresses for since the browse began.
    refreshed: usize,
}

impl Rediscovery {
    /// Whether a browse is on.
    #[must_use]
    pub fn browsing(&self) -> bool {
        self.browsing
    }

    /// How many gateways the core refreshed since the browse began.
    #[must_use]
    pub fn refreshed(&self) -> usize {
        self.refreshed
    }

    /// Begin browsing, once; a second call while one is on asks for nothing.
    pub fn start(&mut self) -> Vec<wire::Effect> {
        if self.browsing {
            return Vec::new();
        }
        self.browsing = true;
        self.refreshed = 0;
        vec![browse(true)]
    }

    /// End the browse. A screen calls this when it no longer wants it (it also
    /// ends when the screen is gone).
    pub fn stop(&mut self) -> Vec<wire::Effect> {
        if !self.browsing {
            return Vec::new();
        }
        self.browsing = false;
        vec![browse(false)]
    }

    /// One window's sightings: match each recorded gateway by its identity,
    /// offer the core what matched. A browse that found nothing, a ledger with
    /// no gateway and a gateway nothing matched ask the core nothing.
    pub fn sighted(&mut self, ctx: &Ctx, sighted: &wire::GatewaysSighted) {
        if !self.browsing || sighted.sightings.is_empty() {
            return;
        }
        for gateway in door::recorded(ctx) {
            let candidates =
                matching::candidates(&gateway.gateway_id, &gateway.addrs, &sighted.sightings);
            if candidates.is_empty() {
                continue;
            }
            door::refresh(ctx, &format!("{TAG_PREFIX}{}", gateway.gateway_id), &gateway.gateway_id, candidates);
            self.pending += 1;
        }
    }

    /// An off-thread answer. `true` when it was one of this piece's refreshes
    /// (the screen holding it ignores it then).
    pub fn heard(&mut self, done: &wire::OffThreadDone) -> bool {
        if !done.tag.starts_with(TAG_PREFIX) {
            return false;
        }
        self.pending = self.pending.saturating_sub(1);
        if door::refreshed(done) {
            self.refreshed += 1;
        }
        true
    }
}

fn browse(on: bool) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::BrowseGateways(wire::BrowseGateways {
            on,
            window_ms: BROWSE_MS,
            repeat_ms: MIN_INTERVAL_MS,
        })),
    }
}
