import UIKit
import XCTest

@testable import CentraidApp

/// THE FACES ARE ACTUALLY IN THE BUNDLE (#1029 follow-on).
///
/// Every type token has said `family: "sans"` — Instrument Sans — since the
/// first one, and until now this shell drew `.system(...)`: SF Pro, on every
/// screen, for the project's whole life. Nothing ever failed, because that is
/// how a missing font fails on iOS. `UIFont(name:size:)` returns nil for an
/// unregistered face, SwiftUI falls back to the system one, and the product
/// renders in somebody else's voice without a single diagnostic.
///
/// `CentraidTypeModifier` now refuses to do that — it `preconditionFailure`s —
/// so the defect has become a crash on the first drawn label. **This test is
/// what turns that crash into a red test instead of a red screenshot.** It
/// fails for each of the three ways the chain can break: the emitter did not
/// copy the `.ttf` into `Resources/Fonts`, `xcodegen generate` was not re-run
/// after `UIAppFonts` changed, or `packages/design/fonts` gained a face the
/// plist does not name.
///
/// ## THIS TEST HAS NEVER RUN IN CI
///
/// Same hand-off as `ScreenFixtureTests`: there is no simulator on the machines
/// that run `cargo xtask gate`, so an owner runs it (`mobile/README.md`). It is
/// written as a complete test rather than a sketch for the same reason.
final class FontRegistrationTests: XCTestCase {
    /// Every emitted PostScript name resolves to a real face.
    func testEveryEmittedFaceResolves() {
        XCTAssertFalse(centraidTypeFaces.isEmpty, "the emitted face table is empty")
        for (family, byWeight) in centraidTypeFaces {
            for (weight, name) in byWeight {
                XCTAssertNotNil(
                    UIFont(name: name, size: 15),
                    "\(family)/\(weight): '\(name)' is not registered — check "
                        + "Resources/Fonts and UIAppFonts in mobile/iosApp/project.yml"
                )
            }
        }
    }

    /// Both weights are DISTINCT faces, not one file answering to two names.
    ///
    /// A copy step that wrote the same bytes twice, or a table whose two rows
    /// carry the same PostScript name, would satisfy the test above and then
    /// render every heading at regular weight — which reads as "the font did not
    /// load" to a reviewer and as nothing at all to a test.
    func testTheWeightsAreDifferentFaces() {
        let names = Set(centraidTypeFaces.values.flatMap(\.values))
        XCTAssertEqual(
            names.count, centraidTypeFaces.values.reduce(0) { $0 + $1.count },
            "two type roles resolve to the same face: \(names.sorted())"
        )
    }

    /// Every type role in the emitted theme has a face, in both schemes.
    ///
    /// The modifier crashes on a role whose (family, weight) pair is missing, so
    /// the pair table and the type table have to cover each other. A weight added
    /// in `packages/design/src/typography.ts` with no file beside it in
    /// `packages/design/fonts` reds HERE rather than on the screen that first
    /// uses that rung.
    func testEveryTypeRoleHasAFace() {
        for theme in [CentraidTokens.light, CentraidTokens.dark] {
            for (role, style) in theme.type where style.family != "code" {
                XCTAssertNotNil(
                    centraidTypeFaces[style.family]?[style.weight],
                    "\(theme.scheme)/\(role): no face for '\(style.family)' at "
                        + "weight \(style.weight)"
                )
            }
        }
    }

    /// THE 400 REGISTER DRAWS THE 470 FACE, AND A RE-POINT REDS HERE.
    ///
    /// Ruled 2026-08-19 and restored for this shell 2026-09-22 (#1029,
    /// `docs/decisions.md`). The touch step the emitted table already carries
    /// grants a phone +2px size and +3px leading over a desktop pane at the same
    /// role, and that step scales the GLYPH without scaling the stroke's optical
    /// presence; CoreText compounds it, drawing with grayscale antialiasing
    /// where a desktop browser gets stem darkening. So a true 400 reads correct
    /// at a desk and THIN in the hand, and the register is lowered to a derived
    /// `usWeightClass` 470 instance on native and only on native.
    ///
    /// **This is a lowering and not a third weight**, which is exactly what
    /// makes it easy to undo by accident: the emitted `weight` stays `400`, so
    /// nothing about the ramp changes and a maintainer re-pointing the 400 row
    /// at the plain upstream static would produce a table that still typechecks,
    /// still resolves, still passes every other test in this file, and renders
    /// the whole product a shade lighter on the device with no diagnostic
    /// anywhere. That is the same class of silence as the missing-face defect
    /// this suite was written for, so it gets the same treatment: a test.
    ///
    /// Three independent claims, because any one of them alone could be
    /// satisfied by the wrong file. The name is the emitter's contract, the
    /// family name is the FACE's own claim about itself read back out of the
    /// registered bytes, and the weight trait is CoreText's reading of
    /// `usWeightClass` — strictly heavier than regular, which the 400 static is
    /// not and cannot be made to be.
    func testTheFourHundredRegisterDrawsTheBookFace() {
        XCTAssertEqual(
            centraidTypeFaces["sans"]?[400], "InstrumentSans-Book",
            "the sans 400 register is no longer lowered to the 470 face — see "
                + "docs/decisions.md and the FACES table in "
                + "contracts/tools/export-native-theme.ts"
        )
        XCTAssertTrue(
            centraidFontFiles.contains("InstrumentSans_470Book.ttf"),
            "the 470 face is not among the emitted files: \(centraidFontFiles)"
        )
        XCTAssertFalse(
            centraidFontFiles.contains("InstrumentSans-Regular.ttf"),
            "the plain 400 static is bundled again; nothing on native renders it"
        )

        guard let book = UIFont(name: "InstrumentSans-Book", size: 15) else {
            return XCTFail("InstrumentSans-Book is not registered")
        }
        XCTAssertEqual(
            book.familyName, "Instrument Sans Book",
            "the registered face does not declare itself the derived Book "
                + "instance — the bytes in Resources/Fonts are not the 470"
        )

        let traits =
            book.fontDescriptor.object(forKey: .traits)
            as? [UIFontDescriptor.TraitKey: Any]
        guard let weight = traits?[.weight] as? CGFloat else {
            return XCTFail("the face carries no weight trait")
        }
        // CoreText normalises usWeightClass onto its own scale, where regular is
        // 0 and medium is about 0.23. The exact number is Apple's business; that
        // it is ABOVE regular is the whole claim, and a 400 static sits at 0.
        XCTAssertGreaterThan(
            weight, 0,
            "the 400 register resolves to a face CoreText reads as regular "
                + "weight — the lowering has been undone"
        )
    }

    /// NOTHING IN THE RAMP NAMES A 470.
    ///
    /// The companion to the test above, and the reason it is safe. DESIGN.md
    /// specifies two weights; the 470 exists only as a file and a PostScript
    /// name, never as a rung. A role emitted at weight 470 would mean the
    /// lowering had leaked upward into the token table, where it would reach the
    /// web through the same source — and the web deliberately draws a true 400.
    func testTheRampStillNamesTwoWeights() {
        for theme in [CentraidTokens.light, CentraidTokens.dark] {
            for (role, style) in theme.type {
                XCTAssertTrue(
                    [400, 600].contains(style.weight),
                    "\(theme.scheme)/\(role): weight \(style.weight) is not a rung "
                        + "the design contract names"
                )
            }
        }
    }

    /// `UIAppFonts` and the emitted file list are one fact in two files.
    func testTheBundleDeclaresEveryEmittedFile() {
        let declared = Bundle(for: FontRegistrationTests.self)
            .object(forInfoDictionaryKey: "UIAppFonts") as? [String]
        // The test bundle carries its own Info.plist, so a nil here is the test
        // host's arrangement and not a product defect; the app bundle is the one
        // that matters and `testEveryEmittedFaceResolves` covers it end to end.
        guard let declared else { return }
        for file in centraidFontFiles {
            XCTAssertTrue(
                declared.contains(file),
                "\(file) is emitted but not named in UIAppFonts"
            )
        }
    }
}
