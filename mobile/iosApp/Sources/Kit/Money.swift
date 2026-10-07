import Foundation

// MONEY IS DRAWN IN ONE PLACE, THE KIT (K5).
//
// Lifted out of `HomeView.swift` so a port renders an amount by naming the kit and
// never by reaching into Home. `contracts/screens/money-render.json` is the law
// both shells answer to: `MoneyRenderTests` asserts this renderer against it and
// the JVM `MoneyRenderSpec` asserts Android's `formatMoney`, so the two cannot
// drift. An EMPTY locale means the device's, which no fixture can pin.

/// THE ONE SWIFT FORMATTER, for the Home tile and the Tally list alike, and the
/// twin of Android's `formatMoney`: two spellings of one amount inside one app
/// would be two answers to "how much".
enum Money {
    static func render(_ money: Centraid_Screen_V1_Money) -> String {
        if money.currency.isEmpty { return "" }
        let exponent = Int(money.exponent)
        // `Decimal` and not a `Double`: an amount that went through a binary
        // float is the rounding bug this whole type exists to prevent.
        let value = Decimal(money.minor) / pow(Decimal(10), exponent)
        let formatter = NumberFormatter()
        formatter.minimumFractionDigits = exponent
        formatter.maximumFractionDigits = exponent
        // THE VAULT'S LOCALE WHEN IT NAMES ONE. A member reading their vault on
        // a borrowed phone must see their own separators.
        if !money.locale.isEmpty { formatter.locale = Locale(identifier: money.locale) }
        // A CODE ISO 4217 DOES NOT KNOW IS SPELLED, NOT SYMBOLISED. The schema
        // takes any three letters, and a currency style handed an unknown code
        // invents a presentation for it; the amount beside its own code is
        // what the row actually says.
        guard Locale.commonISOCurrencyCodes.contains(money.currency) else {
            formatter.numberStyle = .decimal
            let body = formatter.string(from: value as NSDecimalNumber) ?? "\(value)"
            return "\(body) \(money.currency)"
        }
        formatter.numberStyle = .currency
        formatter.currencyCode = money.currency
        return formatter.string(from: value as NSDecimalNumber) ?? "\(value) \(money.currency)"
    }
}

