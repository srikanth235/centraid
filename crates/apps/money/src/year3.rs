//! THE MONEY AXIS OF YEAR-3 VOLUME (#1099).
//!
//! Four accounts and 18,000 transactions over three years (about 6,000 a year),
//! as the CSV text a bank would export, so the whole import path — reader, plan
//! — runs at the volume the product is held to. Deterministic by construction,
//! in the style of the kit's year-3 generators: a date is `start + index`, every
//! choice comes from one seeded integer stream, and no clock, `rand` or hash of
//! a pointer is read. Two runs of the same seed are byte-identical.
//!
//! It is pure text: it writes no vault. Wave 4 seeds the demo vault from it.

/// The declared shape of year-3 Money volume.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Year3MoneyShape {
    pub accounts: usize,
    pub rows_per_account: usize,
    /// First day, `YYYY-MM-DD`.
    pub start: &'static str,
    /// Days the rows spread over.
    pub days: usize,
}

/// Four accounts, 4,500 rows each: 18,000 rows over three years.
pub const YEAR3: Year3MoneyShape = Year3MoneyShape {
    accounts: 4,
    rows_per_account: 4_500,
    start: "2022-01-01",
    days: 1_095,
};

/// One generated account's statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Year3Account {
    pub name: String,
    pub currency: &'static str,
    /// A Chase-shaped CSV: header plus [`Year3MoneyShape::rows_per_account`] rows.
    pub csv: String,
}

const MERCHANTS: [&str; 24] = [
    "STARBUCKS STORE",
    "WHOLE FOODS MKT",
    "SHELL OIL",
    "AMAZON MKTPLACE PMTS",
    "NETFLIX.COM",
    "UBER *TRIP",
    "TRADER JOES",
    "CVS/PHARMACY",
    "COSTCO WHSE",
    "TIM HORTONS",
    "SPOTIFY",
    "PAYROLL ACME CORP",
    "COMCAST CABLE",
    "TARGET",
    "CHIPOTLE",
    "LYFT *RIDE",
    "HOME DEPOT",
    "APPLE.COM/BILL",
    "WALGREENS",
    "PANERA BREAD",
    "DOORDASH",
    "TRANSFER TO SAVINGS",
    "ATM WITHDRAWAL",
    "RENT PAYMENT",
];

fn next(state: &mut u64) -> u64 {
    // SplitMix64: a fixed, well-mixed integer stream.
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// The generated accounts for `seed`.
#[must_use]
pub fn year3(seed: u64) -> Vec<Year3Account> {
    let start = crate::civil::day_number_of(YEAR3.start).unwrap_or(0);
    (0..YEAR3.accounts)
        .map(|account| {
            let mut state = seed ^ (account as u64 + 1).wrapping_mul(0xA24B_AED4_963E_E407);
            let mut rows = Vec::with_capacity(YEAR3.rows_per_account);
            for index in 0..YEAR3.rows_per_account {
                let day = start + i64::try_from(index * YEAR3.days / YEAR3.rows_per_account).unwrap_or(0);
                let merchant = MERCHANTS[usize::try_from(next(&mut state) % 24).unwrap_or(0)];
                let store = next(&mut state) % 9_000 + 1_000;
                let cents = i64::try_from(next(&mut state) % 20_000).unwrap_or(0) + 99;
                let credit = merchant.starts_with("PAYROLL");
                let amount = if credit { cents * 20 } else { -cents };
                let (year, month, date) = crate::civil::from_day_number_parts(day);
                let sign = if amount < 0 { "-" } else { "" };
                rows.push(format!(
                    "{},{month:02}/{date:02}/{year:04},\"{merchant} {store}\",{sign}{}.{:02},{},,,\n",
                    if credit { "CREDIT" } else { "DEBIT" },
                    amount.abs() / 100,
                    amount.abs() % 100,
                    if credit { "ACH_CREDIT" } else { "DEBIT_CARD" },
                ));
            }
            let mut csv = String::from("Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #,\n");
            // Newest first, as banks export it.
            for row in rows.iter().rev() {
                csv.push_str(row);
            }
            Year3Account {
                name: format!("Account {}", account + 1),
                currency: "USD",
                csv,
            }
        })
        .collect()
}
