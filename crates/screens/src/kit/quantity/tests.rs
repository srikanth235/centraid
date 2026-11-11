use super::*;

const EN: Locale = Locale::En;

fn said(quantity: Quantity, pref: UnitsPref) -> String {
    quantity.words(EN, pref)
}

fn took() -> wire::SecretAnswer {
    wire::SecretAnswer {
        ok: true,
        ..Default::default()
    }
}

#[test]
fn a_distance_a_climb_and_a_weight_convert_and_keep_their_rounding() {
    use UnitsPref::{Imperial, Metric};
    assert_eq!(said(Quantity::distance_m(5_200.0), Metric), "5.2 km");
    assert_eq!(said(Quantity::distance_m(5_200.0), Imperial), "3.2 mi");
    assert_eq!(said(Quantity::distance_m(0.0), Metric), "0.0 km");
    assert_eq!(said(Quantity::climb_m(42.0), Metric), "42 m");
    assert_eq!(said(Quantity::climb_m(42.0), Imperial), "138 ft");
    assert_eq!(said(Quantity::climb_m(1_204.0), Metric), "1,204 m");
    assert_eq!(said(Quantity::mass_kg(71.4), Metric), "71.4 kg");
    assert_eq!(said(Quantity::mass_kg(71.4), Imperial), "157.4 lb");
    assert_eq!(said(Quantity::mass_kg(-0.04), Metric), "0.0 kg");
}

#[test]
fn a_pace_is_per_kilometre_or_per_mile_and_needs_a_distance() {
    let pace = Quantity::pace(1_800, 5_000.0).expect("a pace");
    assert_eq!(said(pace, UnitsPref::Metric), "6:00 /km");
    assert_eq!(said(pace, UnitsPref::Imperial), "9:39 /mi");
    assert_eq!(Quantity::pace(0, 5_000.0), None);
    assert_eq!(Quantity::pace(1_800, 0.0), None);
    let slow = Quantity::pace(7_200, 1_000.0).expect("a pace");
    assert_eq!(said(slow, UnitsPref::Metric), "2:00:00 /km");
}

#[test]
fn energy_temperature_and_volume() {
    use UnitsPref::{Imperial, Metric};
    assert_eq!(said(Quantity::energy_kcal(412.4), Metric), "412 kcal");
    assert_eq!(said(Quantity::energy_kcal(1_412.5), Imperial), "1,413 kcal");
    assert_eq!(said(Quantity::celsius(36.6), Metric), "36.6 °C");
    assert_eq!(said(Quantity::celsius(36.6), Imperial), "97.9 °F");
    assert_eq!(said(Quantity::celsius(-5.0), Imperial), "23.0 °F");
    assert_eq!(said(Quantity::millilitres(250.0), Metric), "250 ml");
    assert_eq!(said(Quantity::millilitres(1_500.0), Metric), "1.5 L");
    assert_eq!(said(Quantity::millilitres(250.0), Imperial), "8.5 fl oz");
}

#[test]
fn counts_and_times_ignore_the_switch() {
    for pref in [UnitsPref::Metric, UnitsPref::Imperial] {
        assert_eq!(said(Quantity::steps(8_412.0), pref), "8,412");
        assert_eq!(said(Quantity::beats(61.6), pref), "62 bpm");
        assert_eq!(said(Quantity::minutes(31.0), pref), "31 min");
        assert_eq!(said(Quantity::duration_s(432.0 * 60.0), pref), "7 h 12 min");
        assert_eq!(said(Quantity::duration_s(48.0 * 60.0), pref), "48 min");
        assert_eq!(said(Quantity::duration_s(-60.0), pref), "0 min");
        assert_eq!(said(Quantity::span_s(3_960), pref), "1 h 06 min");
        assert_eq!(said(Quantity::span_s(1_860), pref), "31 min");
        assert_eq!(said(Quantity::span_s(1_829), pref), "30 min");
        assert_eq!(said(Quantity::span_s(1_830), pref), "31 min");
    }
}

#[test]
fn a_figure_comes_apart_into_its_number_and_its_unit_word() {
    let climb = Quantity::climb_m(42.0);
    assert_eq!(
        climb.figure(EN, UnitsPref::Imperial),
        ("138".to_owned(), "ft".to_owned())
    );
    assert_eq!(
        Quantity::steps(8_412.0).figure(EN, UnitsPref::Metric),
        ("8,412".to_owned(), String::new())
    );
    assert_eq!(
        Quantity::bytes(1_400_000).figure(EN, UnitsPref::Metric),
        ("1.4".to_owned(), "MB".to_owned())
    );
}

#[test]
fn a_size_reads_byte_for_byte_as_the_vaults_phrase_whatever_the_switch() {
    for count in [
        -1,
        0,
        1,
        2,
        999,
        1_000,
        1_536,
        999_999,
        1_000_000,
        1_999_999,
        999_999_999,
        1_000_000_000,
        12_345_678_901,
    ] {
        for pref in [UnitsPref::Metric, UnitsPref::Imperial] {
            assert_eq!(
                said(Quantity::bytes(count), pref),
                format_byte_size(count),
                "{count} was said differently"
            );
            let (number, unit) = Quantity::bytes(count).figure(EN, pref);
            assert_eq!(format!("{number} {unit}"), format_byte_size(count));
        }
    }
}

#[test]
fn every_byte_unit_says_a_tenth_below_100_and_whole_from_100_in_every_unit_switch() {
    // ONE RULE, BOTH SIDES OF THE LINE, in Attachments, Chat and Backup alike: the quantity says it.
    for pref in [UnitsPref::Metric, UnitsPref::Imperial] {
        for (count, nearest, floor) in [
            (880_000_i64, "880 KB", "880 KB"),
            (1_200_000, "1.2 MB", "1.2 MB"),
            (99_960_000, "100 MB", "99.9 MB"),
            (100_000_000, "100 MB", "100 MB"),
            (205_000_000, "205 MB", "205 MB"),
            (42_550_000_000, "42.6 GB", "42.5 GB"),
            (99_960_000_000, "100 GB", "99.9 GB"),
            (512_000_000_000, "512 GB", "512 GB"),
        ] {
            assert_eq!(said(Quantity::bytes(count), pref), nearest, "{count}");
            assert_eq!(
                said(Quantity::bytes_floor(u64::try_from(count).unwrap()), pref),
                floor,
                "{count}"
            );
        }
    }
}

#[test]
fn only_the_regions_that_measure_in_miles_default_to_imperial() {
    for region in ["US", "LR", "MM"] {
        assert_eq!(UnitsPref::of_region(region), UnitsPref::Imperial);
    }
    for region in ["GB", "DE", "JP", ""] {
        assert_eq!(UnitsPref::of_region(region), UnitsPref::Metric);
    }
}

#[test]
fn a_choice_is_kept_read_back_and_beats_the_region_until_it_is_cleared() {
    let secrets = VaultSecrets::new();
    assert_eq!(stored(&secrets), None);
    assert_eq!(effective(stored(&secrets), "US"), UnitsPref::Imperial);
    assert_eq!(effective(stored(&secrets), "DE"), UnitsPref::Metric);

    let keep = [set_op(Some(UnitsPref::Imperial))];
    assert_eq!(keep[0].key, UNITS_KEY);
    secrets.absorb(&keep, &[took()]);
    assert_eq!(stored(&secrets), Some(UnitsPref::Imperial));
    assert_eq!(effective(stored(&secrets), "DE"), UnitsPref::Imperial);

    let metric = [set_op(Some(UnitsPref::Metric))];
    secrets.absorb(&metric, &[took()]);
    assert_eq!(effective(stored(&secrets), "US"), UnitsPref::Metric);

    // A write the platform refused is not a choice.
    let refused = [set_op(Some(UnitsPref::Imperial))];
    secrets.absorb(&refused, &[wire::SecretAnswer::default()]);
    assert_eq!(stored(&secrets), Some(UnitsPref::Metric));

    let clear = [set_op(None)];
    secrets.absorb(&clear, &[took()]);
    assert_eq!(stored(&secrets), None);
    assert_eq!(effective(stored(&secrets), "US"), UnitsPref::Imperial);
    assert_eq!(effective(stored(&secrets), "DE"), UnitsPref::Metric);
}

#[test]
fn an_unreadable_stored_value_follows_the_region() {
    assert_eq!(UnitsPref::of_stored("metric"), Some(UnitsPref::Metric));
    assert_eq!(
        UnitsPref::of_stored(" imperial\n"),
        Some(UnitsPref::Imperial)
    );
    assert_eq!(UnitsPref::of_stored("furlongs"), None);
    assert_eq!(UnitsPref::of_stored(""), None);
}
