//! The addresses a pairing QR lists, in the order a phone should try them
//! (#1080).
//!
//! The bound port on every non-loopback interface address — IPv4 first, the
//! address family a home LAN is surest to route — then the host's name with
//! `.local`, which iOS resolves through Bonjour and other stacks may not.
//! A gateway bound to one address lists that address; one bound to loopback
//! lists loopback, which is what a test wants and a member never sees.
//! Link-local IPv6 is left out: it needs a zone the phone cannot know.

use std::net::{IpAddr, SocketAddr};

use crate::rules::payload::MAX_ADDRS;

/// The addresses for a gateway bound at `bound`.
#[must_use]
pub fn advertised(bound: SocketAddr) -> Vec<String> {
    let port = bound.port();
    let mut out = Vec::new();
    if bound.ip().is_loopback() {
        out.push(bound.to_string());
        return out;
    }
    if bound.ip().is_unspecified() {
        let mut ips = interface_ips();
        if bound.is_ipv4() {
            ips.retain(IpAddr::is_ipv4);
        }
        ips.sort_by_key(|ip| (ip.is_ipv6(), *ip));
        out.extend(
            ips.into_iter()
                .map(|ip| SocketAddr::new(ip, port).to_string()),
        );
    } else {
        out.push(bound.to_string());
    }
    if let Some(host) = host_name() {
        with_host(&mut out, &host, port);
    }
    out.truncate(MAX_ADDRS);
    out
}

/// The host's `.local` name goes last and always fits: a host with eight or
/// more interface addresses (Docker networks, a VPN) would otherwise lose the
/// one entry that still answers after the laptop moved to a new address.
fn with_host(out: &mut Vec<String>, host: &str, port: u16) {
    out.truncate(MAX_ADDRS - 1);
    out.push(format!("{host}.local:{port}"));
}

/// Every interface address worth listing.
fn interface_ips() -> Vec<IpAddr> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    let mut ips: Vec<IpAddr> = interfaces
        .into_iter()
        .map(|interface| interface.ip())
        .filter(|ip| !ip.is_loopback() && !ip.is_unspecified() && !is_link_local_v6(ip))
        .collect();
    ips.dedup();
    ips
}

fn is_link_local_v6(ip: &IpAddr) -> bool {
    matches!(ip, IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) == 0xfe80)
}

/// The host's own name, its first label only — `ada-laptop`, whether the OS
/// says `ada-laptop`, `ada-laptop.local` or `ada-laptop.example.org` — or
/// `None` when it is not a name Bonjour can carry.
#[must_use]
pub fn host_name() -> Option<String> {
    let full = gethostname::gethostname().into_string().ok()?;
    let label = full.split('.').next()?.to_owned();
    let usable = !label.is_empty()
        && label.len() <= 63
        && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    usable.then_some(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_loopback_gateway_lists_loopback_alone() {
        let bound: SocketAddr = "127.0.0.1:41000".parse().expect("an address");
        assert_eq!(advertised(bound), vec!["127.0.0.1:41000".to_owned()]);
    }

    #[test]
    fn a_gateway_bound_to_one_address_lists_it_first() {
        let bound: SocketAddr = "192.168.1.20:8443".parse().expect("an address");
        let listed = advertised(bound);
        assert_eq!(listed[0], "192.168.1.20:8443");
        assert!(listed.len() <= MAX_ADDRS);
    }

    #[test]
    fn every_listed_address_is_one_a_payload_accepts() {
        let bound: SocketAddr = "0.0.0.0:8443".parse().expect("an address");
        for addr in advertised(bound) {
            assert!(crate::rules::payload::is_host_port(&addr), "{addr}");
            assert!(!addr.starts_with("127."), "{addr}");
        }
    }

    #[test]
    fn the_host_name_survives_a_host_with_many_addresses() {
        let mut out: Vec<String> = (0..12).map(|i| format!("10.0.{i}.1:8443")).collect();
        with_host(&mut out, "ada-laptop", 8443);
        assert_eq!(out.len(), MAX_ADDRS);
        assert_eq!(
            out.last().map(String::as_str),
            Some("ada-laptop.local:8443")
        );
    }

    #[test]
    fn link_local_ipv6_is_recognised() {
        assert!(is_link_local_v6(&"fe80::1".parse().expect("an address")));
        assert!(!is_link_local_v6(&"fd00::1".parse().expect("an address")));
    }
}
