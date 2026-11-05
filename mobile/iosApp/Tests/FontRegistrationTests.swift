import SwiftUI
import UIKit
import XCTest

@testable import CentraidApp

/// The font contract must resolve to registered faces, including the mono face.
final class FontRegistrationTests: XCTestCase {
    func testEveryEmittedFaceResolves() {
        XCTAssertFalse(centraidTypeFaces.isEmpty)
        for (family, weights) in centraidTypeFaces {
            for (weight, name) in weights {
                XCTAssertNotNil(UIFont(name: name, size: 16), "\(family)/\(weight): \(name) is not registered")
            }
        }
    }

    func testTheWeightsAreDifferentFaces() {
        let names = centraidTypeFaces.values.flatMap(\.values)
        XCTAssertEqual(Set(names).count, names.count)
    }

    func testEveryTypeRoleHasItsRequestedFace() {
        for theme in [CentraidTokens.light, CentraidTokens.dark] {
            for (role, style) in theme.type {
                XCTAssertNotNil(centraidTypeFaces[style.family]?[style.weight], "\(theme.scheme)/\(role)")
            }
        }
    }

    func testAccessibilitySizesContinuePastTheOrdinaryTextSizes() {
        let ordinary = Theme.resolve("body", .light, .xxxLarge)
        let accessibility = Theme.resolve("body", .light, .accessibility5)
        XCTAssertGreaterThan(accessibility.font.pointSize, ordinary.font.pointSize)
        XCTAssertGreaterThan(accessibility.lineHeight, ordinary.lineHeight)
        XCTAssertGreaterThanOrEqual(accessibility.lineHeight, accessibility.font.pointSize)
    }

    func testTheBundleDeclaresEveryEmittedFile() throws {
        let declared = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "UIAppFonts") as? [String])
        XCTAssertEqual(Set(declared), Set(centraidFontFiles))
    }
}
