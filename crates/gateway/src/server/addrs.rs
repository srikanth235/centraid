//! The addresses and label a pairing QR and `/v1/info` advertise (#1080, #1212).
//!
//! Discovered interface addresses are ordered for home LANs and Tailscale
//! first — RFC1918 LAN (`192.168.0.0/16`, `10.0.0.0/8` outside container CNI
//! overlays) and Tailscale CGNAT (`100.64.0.0/10`) ahead of public IPv4,
//! `172.16.0.0/12` Docker bridges (`172.17.0.1`), and IPv6 — followed by the
//! host's `.local` mDNS name and any operator-supplied `--announce <host:port>`
//! entries. Link-local IPv6 is left out because it needs an interface zone the
//! phone cannot know.

use std::net::{IpAddr, Ipv6Addr, SocketAddr};

use crate::rules::limits::MAX_LABEL_BYTES;
use crate::rules::payload::{MAX_ADDRS, is_host_port};

/// Fallback gateway label when no `--name` is configured and the OS hostname is unusable.
pub const DEFAULT_GATEWAY_NAME: &str = "gateway";

/// The addresses for a gateway bound at `bound`, with no extra `--announce` entries.
#[must_use]
pub fn advertised(bound: SocketAddr) -> Vec<String> {
    advertised_with(bound, &[])
}

/// The addresses for a gateway bound at `bound`, appending any valid
/// `--announce` entries (`ip:port`, `[ipv6]:port`, or `hostname:port`).
#[must_use]
pub fn advertised_with(bound: SocketAddr, announced: &[String]) -> Vec<String> {
    assemble_addresses(bound, interface_ips(), host_name().as_deref(), announced)
}

/// Normalize one `--announce` entry against `default_port`, accepting
/// `host:port`, `ipv4:port`, `[ipv6]:port`, or a bare host / IP (to which
/// `:default_port` is appended). Returns `None` if malformed.
#[must_use]
pub fn normalize_announce(entry: &str, default_port: u16) -> Option<String> {
    let trimmed = entry.trim();
    if trimmed.is_empty() {
        return None;
    }
    if is_host_port(trimmed) {
        return Some(trimmed.to_owned());
    }
    if default_port == 0 {
        return None;
    }
    if !trimmed.contains(':') {
        let candidate = format!("{trimmed}:{default_port}");
        return is_host_port(&candidate).then_some(candidate);
    }
    if let Ok(v6) = trimmed.parse::<Ipv6Addr>() {
        let candidate = format!("[{v6}]:{default_port}");
        return is_host_port(&candidate).then_some(candidate);
    }
    None
}

/// Clean an explicit `--name` or fall back to the OS's clean hostname (with
/// trailing `.local` / `.lan` stripped), or `"gateway"` if empty.
#[must_use]
pub fn clean_gateway_name(configured: Option<&str>) -> String {
    if let Some(raw) = configured
        && let Some(cleaned) = sanitize_label(raw)
    {
        return cleaned;
    }
    let os_host = gethostname::gethostname();
    clean_hostname(&os_host.to_string_lossy())
}

/// Strip trailing `.`, `.local`, or `.lan` from a hostname, falling back to
/// [`DEFAULT_GATEWAY_NAME`] when empty or containing control characters.
#[must_use]
pub fn clean_hostname(raw: &str) -> String {
    let mut trimmed = raw.trim().trim_end_matches('.');
    for suffix in [".local", ".lan"] {
        if trimmed.len() > suffix.len()
            && trimmed[trimmed.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
        {
            trimmed = &trimmed[..trimmed.len() - suffix.len()];
            break;
        }
    }
    sanitize_label(trimmed).unwrap_or_else(|| DEFAULT_GATEWAY_NAME.to_owned())
}

fn is_invisible_or_bidi(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{00AD}'
                | '\u{061C}'
                | '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'
                | '\u{2066}'..='\u{2069}'
                | '\u{FEFF}'
        )
}

fn sanitize_label(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| !is_invisible_or_bidi(*c))
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() <= MAX_LABEL_BYTES {
        return Some(trimmed.to_owned());
    }
    let mut end = MAX_LABEL_BYTES;
    while !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    let truncated = trimmed[..end].trim();
    (!truncated.is_empty()).then_some(truncated.to_owned())
}

/// Lower rank sorts earlier:
/// 0 = `192.168.0.0/16` LAN
/// 1 = `10.0.0.0/8` LAN (excluding known CNI overlay subnets)
/// 2 = `100.64.0.0/10` Tailscale / CGNAT
/// 3 = public routable IPv4
/// 4 = `172.16.0.0/12` (Docker bridge `172.17.0.1`, etc.)
/// 5 = container/CNI bridge interfaces & IPv4 link-local (`169.254.0.0/16`)
/// 6 = global unicast IPv6
/// 7 = IPv6 ULA (`fc00::/7`)
/// 8 = other non-link-local IPv6
#[must_use]
pub fn ip_rank(ip: &IpAddr, iface_name: Option<&str>) -> u8 {
    let on_bridge = iface_name.is_some_and(is_container_bridge);
    match ip {
        IpAddr::V4(v4) => {
            if on_bridge {
                return 5;
            }
            let [a, b, _, _] = v4.octets();
            if a == 192 && b == 168 {
                0
            } else if a == 10 {
                if matches!(b, 42 | 43 | 88 | 244) {
                    5
                } else {
                    1
                }
            } else if a == 100 && (64..=127).contains(&b) {
                2
            } else if a == 169 && b == 254 {
                5
            } else if a == 172 && (16..=31).contains(&b) {
                4
            } else {
                3
            }
        }
        IpAddr::V6(v6) => {
            if on_bridge {
                8
            } else if (v6.segments()[0] & 0xe000) == 0x2000 {
                6
            } else if (v6.segments()[0] & 0xfe00) == 0xfc00 {
                7
            } else {
                8
            }
        }
    }
}

fn is_container_bridge(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        "docker", "br-", "cni", "flannel", "veth", "virbr", "cali", "podman", "nerdctl", "lxcbr",
        "kube-", "tunl",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
}

fn assemble_addresses(
    bound: SocketAddr,
    mut interfaces: Vec<(String, IpAddr)>,
    host: Option<&str>,
    announced: &[String],
) -> Vec<String> {
    let port = bound.port();
    let mut extras = Vec::new();
    for entry in announced {
        if let Some(valid) = normalize_announce(entry, port)
            && !extras.contains(&valid)
        {
            extras.push(valid);
        }
        if extras.len() == MAX_ADDRS {
            break;
        }
    }

    if bound.ip().is_loopback() {
        let mut out = vec![bound.to_string()];
        for extra in extras {
            if out.len() >= MAX_ADDRS {
                break;
            }
            if !out.contains(&extra) {
                out.push(extra);
            }
        }
        return out;
    }

    let mut out = Vec::new();
    if bound.ip().is_unspecified() {
        if bound.is_ipv4() {
            interfaces.retain(|(_, ip)| ip.is_ipv4());
        }
        interfaces.sort_by_key(|(iface, ip)| (ip_rank(ip, Some(iface.as_str())), *ip));
        for (_, ip) in interfaces {
            let candidate = SocketAddr::new(ip, port).to_string();
            if !out.contains(&candidate) && !extras.contains(&candidate) {
                out.push(candidate);
            }
        }
    } else {
        let primary = bound.to_string();
        if !extras.contains(&primary) {
            out.push(primary);
        }
    }

    let local_entry = host
        .map(|label| format!("{label}.local:{port}"))
        .filter(|entry| is_host_port(entry) && !extras.contains(entry) && !out.contains(entry));

    let tail_slots = extras.len() + usize::from(local_entry.is_some() && extras.len() < MAX_ADDRS);
    out.truncate(MAX_ADDRS.saturating_sub(tail_slots));
    if let Some(local) = local_entry
        && out.len() + extras.len() < MAX_ADDRS
    {
        out.push(local);
    }
    for extra in extras {
        if out.len() >= MAX_ADDRS {
            break;
        }
        if !out.contains(&extra) {
            out.push(extra);
        }
    }
    out
}

/// The host's `.local` name goes last and always fits when no extra `--announce`
/// addresses fill the cap.
#[cfg(test)]
fn with_host(out: &mut Vec<String>, host: &str, port: u16) {
    out.truncate(MAX_ADDRS - 1);
    out.push(format!("{host}.local:{port}"));
}

/// Every non-loopback, non-link-local interface `(name, ip)`.
fn interface_ips() -> Vec<(String, IpAddr)> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for interface in interfaces {
        let ip = interface.ip();
        if ip.is_loopback() || ip.is_unspecified() || is_link_local_v6(&ip) {
            continue;
        }
        if !found.iter().any(|(_, existing)| *existing == ip) {
            found.push((interface.name, ip));
        }
    }
    found
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
    bonjour_host_label(&full)
}

/// Extract a valid single-label mDNS host name (`[A-Za-z0-9-]{1,63}`) from `raw`.
#[must_use]
pub fn bonjour_host_label(raw: &str) -> Option<String> {
    let label = raw.trim().split('.').next()?.to_owned();
    let usable = !label.is_empty()
        && label.len() <= 63
        && !label.starts_with('-')
        && !label.ends_with('-')
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

    /// RFC1918 LAN (`192.168.0.0/16`, `10.0.0.0/8`) and Tailscale CGNAT
    /// (`100.64.0.0/10`) sort ahead of Docker's `172.17.0.1` (`172.16.0.0/12`),
    /// CNI container bridges, and IPv6.
    #[test]
    fn lan_and_tailscale_sort_ahead_of_docker_bridge_and_ipv6() {
        let bound: SocketAddr = "[::]:8443".parse().expect("unspecified v6");
        let interfaces = vec![
            (
                "fd0".to_owned(),
                "fd7a:115c:a1e0::5".parse::<IpAddr>().expect("ula v6"),
            ),
            (
                "docker0".to_owned(),
                "172.17.0.1".parse::<IpAddr>().expect("docker"),
            ),
            (
                "br-9f12a".to_owned(),
                "172.18.0.1".parse::<IpAddr>().expect("compose bridge"),
            ),
            (
                "cni0".to_owned(),
                "10.244.0.1".parse::<IpAddr>().expect("cni"),
            ),
            (
                "tailscale0".to_owned(),
                "100.101.102.103".parse::<IpAddr>().expect("tailscale"),
            ),
            (
                "eth1".to_owned(),
                "10.0.1.25".parse::<IpAddr>().expect("rfc1918 10/8"),
            ),
            (
                "wlan0".to_owned(),
                "192.168.1.50"
                    .parse::<IpAddr>()
                    .expect("rfc1918 192.168/16"),
            ),
        ];
        let listed = assemble_addresses(bound, interfaces, Some("home-nas"), &[]);
        let pos = |needle: &str| {
            listed
                .iter()
                .position(|addr| addr == needle)
                .unwrap_or_else(|| panic!("{needle} missing in {listed:?}"))
        };
        assert_eq!(listed[0], "192.168.1.50:8443");
        assert_eq!(listed[1], "10.0.1.25:8443");
        assert_eq!(listed[2], "100.101.102.103:8443");
        assert!(pos("192.168.1.50:8443") < pos("172.17.0.1:8443"));
        assert!(pos("100.101.102.103:8443") < pos("172.17.0.1:8443"));
        assert!(pos("172.17.0.1:8443") < pos("[fd7a:115c:a1e0::5]:8443"));
        assert_eq!(
            listed.last().map(String::as_str),
            Some("home-nas.local:8443")
        );
    }

    #[test]
    fn announced_ip_and_hostname_entries_are_included_even_with_many_interfaces() {
        let bound: SocketAddr = "0.0.0.0:8443".parse().expect("unspecified v4");
        let interfaces: Vec<(String, IpAddr)> = (1..=10)
            .map(|i| {
                (
                    format!("eth{i}"),
                    format!("192.168.{i}.10").parse().expect("ip"),
                )
            })
            .collect();
        let announced = vec![
            "nas.tail1234.ts.net:8443".to_owned(),
            "203.0.113.42:9443".to_owned(),
            "backup.home.arpa".to_owned(),
        ];
        let listed = assemble_addresses(bound, interfaces, Some("home-nas"), &announced);
        assert_eq!(listed.len(), MAX_ADDRS);
        assert!(
            listed.contains(&"nas.tail1234.ts.net:8443".to_owned()),
            "{listed:?}"
        );
        assert!(
            listed.contains(&"203.0.113.42:9443".to_owned()),
            "{listed:?}"
        );
        assert!(
            listed.contains(&"backup.home.arpa:8443".to_owned()),
            "{listed:?}"
        );
        assert!(
            listed.contains(&"home-nas.local:8443".to_owned()),
            "{listed:?}"
        );
        for addr in &listed {
            assert!(is_host_port(addr), "{addr}");
        }
    }

    #[test]
    fn clean_hostname_strips_local_and_lan_and_falls_back_to_gateway() {
        assert_eq!(clean_hostname("ada-macbook.local"), "ada-macbook");
        assert_eq!(clean_hostname("ada-macbook.local."), "ada-macbook");
        assert_eq!(clean_hostname("home-nas.LAN"), "home-nas");
        assert_eq!(clean_hostname("vps-01"), "vps-01");
        assert_eq!(clean_hostname("   "), "gateway");
        assert_eq!(clean_gateway_name(Some("  Studio NAS  ")), "Studio NAS");
    }

    #[test]
    fn sanitize_label_strips_bidi_and_zero_width_characters() {
        assert_eq!(
            sanitize_label("My\u{202E}NAS\u{200B}\u{FEFF}\u{2066}1\u{2069}\u{061C}\u{00AD}"),
            Some("MyNAS1".to_owned())
        );
        assert_eq!(
            sanitize_label("\u{200E}\u{200F}\u{200C}\u{200D}\u{2060}"),
            None
        );
    }
}
