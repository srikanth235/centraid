//! WHICH SIGHTING IS WHICH GATEWAY (#1080, Q-1080-D3): by identity, never by
//! name. The core dials what this offers with the certificate it pinned and
//! asks the gateway its own id (`refresh_destination`); this is the rule for
//! what is offered at all.
//!
//! **BY IDENTITY, NEVER BY NAME.** A sighting is a paired gateway's only when
//! its TXT `gw` equals that gateway's id, compared as hex without regard to
//! case. The instance name is the first eight characters of the id and anyone
//! on the network can advertise one, so a sighting with the right name and no
//! `gw`, or with another `gw`, is nobody's. Even a sighting that passes is only
//! a hint: a machine that lies in its TXT record is refused by TLS.

use centraid_api_proto::core_v1 as wire;

/// The Bonjour service type `serve` advertises, `crates/gateway`'s
/// `SERVICE_TYPE`. The shells browse for it.
pub const SERVICE_TYPE: &str = "_centraid-gateway._tcp";

/// The TXT key carrying the gateway's id.
pub const ID_KEY: &str = "gw";

/// At most this many addresses are offered at once; the core's own cap.
pub const MAX_CANDIDATES: usize = 8;

const MAX_PORT: u32 = 65_535;
const PORT_DIGITS: usize = 5;
const OCTET_DIGITS: usize = 3;
const MAX_OCTET: u32 = 255;
const LOOPBACK_FIRST: u32 = 127;
const MULTICAST_FIRST: u32 = 224;
const HEXTET: usize = 4;

/// The id a sighting claims, or `None` when it claims none the rule can
/// compare: absent, blank, or not hex. TXT keys are case-insensitive.
#[must_use]
pub fn identity_of(sighting: &wire::GatewaySighting) -> Option<String> {
    // The same answer whichever of two differently-cased keys comes first.
    let claimed = sighting
        .txt
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case(ID_KEY))
        .min_by(|a, b| a.0.cmp(b.0))
        .map(|(_, value)| value.trim().to_lowercase())?;
    (!claimed.is_empty() && claimed.chars().all(is_hex)).then_some(claimed)
}

/// Whether `sighting` claims to be the gateway `gateway_id`.
#[must_use]
pub fn is_gateway(sighting: &wire::GatewaySighting, gateway_id: &str) -> bool {
    let wanted = gateway_id.trim().to_lowercase();
    !wanted.is_empty() && identity_of(sighting).as_deref() == Some(wanted.as_str())
}

/// The addresses to offer for `gateway_id`: those of every sighting that claims
/// it, that `recorded` does not already hold (the core dials those anyway), as
/// `host:port` IP literals, each once, IPv4 before IPv6, at most
/// [`MAX_CANDIDATES`].
#[must_use]
pub fn candidates(
    gateway_id: &str,
    recorded: &[String],
    sightings: &[wire::GatewaySighting],
) -> Vec<String> {
    let held: Vec<String> = recorded.iter().filter_map(|a| normalise(a)).collect();
    let mut offered: Vec<String> = Vec::new();
    for address in sightings
        .iter()
        .filter(|sighting| is_gateway(sighting, gateway_id))
        .flat_map(|sighting| sighting.addresses.iter())
        .filter_map(|address| normalise(address))
    {
        if !held.contains(&address) && !offered.contains(&address) {
            offered.push(address);
        }
    }
    let (v6, v4): (Vec<String>, Vec<String>) =
        offered.into_iter().partition(|address| address.starts_with('['));
    v4.into_iter().chain(v6).take(MAX_CANDIDATES).collect()
}

/// One address as the core will read it, or `None` when the rule will not offer
/// it: `a.b.c.d:port` or `[v6]:port`, a port from 1 to 65535, and no name, no
/// unspecified, multicast or loopback address and no IPv6 link-local address,
/// which cannot be dialled without a scope the advertisement does not carry.
#[must_use]
pub fn normalise(address: &str) -> Option<String> {
    let text = address.trim();
    if let Some(rest) = text.strip_prefix('[') {
        let close = rest.find("]:")?;
        let host = &rest[..close];
        let port = port_of(&rest[close + 2..])?;
        return is_routable_v6(host).then(|| format!("[{}]:{port}", host.to_lowercase()));
    }
    let colon = text.rfind(':').filter(|colon| *colon > 0)?;
    let host = &text[..colon];
    let port = port_of(&text[colon + 1..])?;
    is_routable_v4(host).then(|| format!("{host}:{port}"))
}

fn digits(text: &str, longest: usize) -> Option<u32> {
    if text.is_empty() || text.len() > longest || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

fn port_of(text: &str) -> Option<u32> {
    digits(text, PORT_DIGITS).filter(|port| (1..=MAX_PORT).contains(port))
}

fn is_routable_v4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let mut octets = Vec::with_capacity(4);
    for part in parts {
        match digits(part, OCTET_DIGITS).filter(|octet| *octet <= MAX_OCTET) {
            Some(octet) => octets.push(octet),
            None => return false,
        }
    }
    // 0.0.0.0/8 (unspecified), 127/8 (this phone), 224/4 (multicast), 240/4
    // (reserved, broadcast).
    let first = octets[0];
    first != 0 && first != LOOPBACK_FIRST && first < MULTICAST_FIRST
}

fn is_routable_v6(host: &str) -> bool {
    let lowered = host.to_lowercase();
    if !lowered.contains(':') || !lowered.chars().all(|c| c == ':' || is_hex(c)) {
        return false;
    }
    // `::` and `::1`, then link-local fe80::/10 and multicast ff00::/8 by the
    // first group.
    if lowered == "::" || lowered == "::1" {
        return false;
    }
    let first = lowered.split(':').next().unwrap_or_default();
    if first.len() > HEXTET {
        return false;
    }
    let head = format!("{first:0>HEXTET$}");
    let top = u32::from_str_radix(&head[0..2], 16).unwrap_or(0);
    let second = u32::from_str_radix(&head[2..4], 16).unwrap_or(0);
    let link_local = top == 0xfe && (second & 0xc0) == 0x80;
    !link_local && top != 0xff
}

fn is_hex(c: char) -> bool {
    matches!(c, '0'..='9' | 'a'..='f')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> String {
        "ab".repeat(32)
    }

    fn other() -> String {
        "cd".repeat(32)
    }

    fn sighting(name: &str, gw: Option<&str>, addresses: &[&str]) -> wire::GatewaySighting {
        let mut txt = std::collections::HashMap::from([("v".to_owned(), "2".to_owned())]);
        if let Some(gw) = gw {
            txt.insert("gw".to_owned(), gw.to_owned());
        }
        wire::GatewaySighting {
            service_name: name.to_owned(),
            txt,
            addresses: addresses.iter().map(|a| (*a).to_owned()).collect(),
        }
    }

    #[test]
    fn a_sighting_is_a_gateways_only_by_the_id_in_its_txt_record() {
        let named = format!("centraid-gateway-{}", &id()[..8]);
        assert!(is_gateway(&sighting(&named, Some(&id()), &[]), &id()));
        assert!(is_gateway(&sighting("anything", Some(&id().to_uppercase()), &[]), &id()));
        // THE NAME IS NOT AN IDENTITY: the right name with no id, or with
        // another gateway's, is nobody's.
        assert!(!is_gateway(&sighting(&named, None, &[]), &id()));
        assert!(!is_gateway(&sighting(&named, Some(&other()), &[]), &id()));
        assert!(!is_gateway(&sighting(&named, Some(""), &[]), &id()));
        assert!(!is_gateway(&sighting(&named, Some("not hex"), &[]), &id()));
        assert!(!is_gateway(&sighting(&named, Some(&id()), &[]), ""));
        // TXT KEYS ARE CASE-INSENSITIVE.
        let upper = wire::GatewaySighting {
            service_name: named,
            txt: std::collections::HashMap::from([("GW".to_owned(), id())]),
            addresses: Vec::new(),
        };
        assert!(is_gateway(&upper, &id()));
    }

    #[test]
    fn a_record_claims_an_id_only_when_it_holds_a_hex_one() {
        // The browse's own filter on what is worth a connection (the iOS
        // browse test's `claimsGateway`): a blank or absent `gw` claims none.
        assert_eq!(identity_of(&sighting("a", Some(&id()), &[])), Some(id()));
        assert_eq!(identity_of(&sighting("a", Some("  "), &[])), None);
        assert_eq!(identity_of(&sighting("a", None, &[])), None);
        let empty = wire::GatewaySighting::default();
        assert_eq!(identity_of(&empty), None);
    }

    #[test]
    fn only_the_matching_sightings_dialable_addresses_are_offered_new_ones_once_ipv4_first() {
        let sightings = vec![
            sighting(
                "a",
                Some(&id()),
                &["[2001:db8::7]:7443", "192.168.1.44:7443", "192.168.1.44:7443"],
            ),
            sighting("b", Some(&other()), &["192.168.1.99:7443"]),
            sighting("c", Some(&id()), &["192.168.1.20:7443", "laptop.local:7443"]),
        ];
        assert_eq!(
            candidates(&id(), &["192.168.1.20:7443".to_owned()], &sightings),
            vec!["192.168.1.44:7443".to_owned(), "[2001:db8::7]:7443".to_owned()]
        );
        assert_eq!(
            candidates(&other(), &[], &sightings),
            vec!["192.168.1.99:7443".to_owned()]
        );
        assert!(candidates(&"ef".repeat(32), &[], &sightings).is_empty());
    }

    #[test]
    fn an_address_is_offered_only_as_an_ip_literal_the_core_can_dial() {
        assert_eq!(normalise("192.168.1.44:7443").as_deref(), Some("192.168.1.44:7443"));
        assert_eq!(normalise("[2001:DB8::7]:7443").as_deref(), Some("[2001:db8::7]:7443"));
        for bad in [
            "laptop.local:7443",
            "192.168.1.44",
            "192.168.1.44:0",
            "192.168.1.44:70000",
            "0.0.0.0:7443",
            "127.0.0.1:7443",
            "224.0.0.251:5353",
            "999.1.1.1:7443",
            "[fe80::1]:7443",
            "[fe80::1%en0]:7443",
            "[ff02::fb]:5353",
            "[::1]:7443",
            "[::]:7443",
            "",
            ":7443",
        ] {
            assert_eq!(normalise(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn no_more_than_the_cores_cap_is_offered() {
        let addresses: Vec<String> = (1..=20).map(|n| format!("10.0.0.{n}:7443")).collect();
        let refs: Vec<&str> = addresses.iter().map(String::as_str).collect();
        let many = sighting("a", Some(&id()), &refs);
        assert_eq!(candidates(&id(), &[], &[many]).len(), MAX_CANDIDATES);
    }
}
