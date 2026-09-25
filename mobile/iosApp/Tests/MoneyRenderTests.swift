import Foundation
import XCTest

@testable import CentraidApp

/// ONE MONEY LAW, TWO RENDERERS (K5).
///
/// `contracts/screens/money-render.json` is the law; the JVM `MoneyRenderSpec`
/// holds Android's `formatMoney` to it and this holds `Money.render` — the kit
/// renderer every Swift amount goes through — to the same cases, so the two
/// shells cannot spell one amount two ways.
final class MoneyRenderTests: XCTestCase {
    private var fixture: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // iosApp
            .deletingLastPathComponent()   // mobile
            .deletingLastPathComponent()   // the repo root
            .appendingPathComponent("contracts/screens/money-render.json")
    }

    func testEveryFixtureCaseRendersAsTheLawSays() throws {
        let decoded = try JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any]
        let cases = try XCTUnwrap(decoded?["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty, "the fixture names no cases")
        for entry in cases {
            let name = try XCTUnwrap(entry["name"] as? String)
            var money = Centraid_Screen_V1_Money()
            money.minor = try XCTUnwrap((entry["minor"] as? NSNumber)?.int64Value, name)
            money.currency = try XCTUnwrap(entry["currency"] as? String, name)
            money.exponent = try XCTUnwrap((entry["exponent"] as? NSNumber)?.uint32Value, name)
            money.locale = try XCTUnwrap(entry["locale"] as? String, name)
            let expected = try XCTUnwrap(entry["expected"] as? String, name)
            XCTAssertEqual(Money.render(money), expected, name)
        }
    }

    func testNoCurrencyRendersNothing() {
        XCTAssertEqual(Money.render(Centraid_Screen_V1_Money()), "")
    }
}
