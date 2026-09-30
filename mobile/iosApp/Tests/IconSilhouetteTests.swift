import CoreGraphics
import XCTest

@testable import CentraidApp

/// THE SILHOUETTES PARSE — all of them, not the ones a screen happened to draw
/// (#1020, wave A).
///
/// `SVGPath` exists because SwiftUI has no path-data parser and Compose does,
/// so the emitted `d` strings cross unchanged into both shells. That asymmetry
/// is the risk this file covers: Compose's `PathParser` is Google's and is
/// exercised by every Android app, and the Swift half is ours and is exercised
/// by whatever Home puts on screen.
///
/// **IT WAS WRITTEN AFTER A FAILURE IT WOULD HAVE CAUGHT.** The first parser
/// read a number greedily, so `l.1.1` — two numbers in the SVG grammar, because
/// a number ends wherever it cannot continue — came back as one malformed one.
/// `SVGPath.parse` returns `nil` on a malformed path and the renderer skips it
/// and draws the next, so the Settings gear silently vanished and left only the
/// small circle inside it. Nothing failed; the glyph was just wrong, and only on
/// the one icon in the set that spells a coordinate that way.
///
/// So the assertion is over the WHOLE emitted table. An icon that does not parse
/// is a defect whether or not this wave's screens draw it.
final class IconSilhouetteTests: XCTestCase {
    func testEveryEmittedSilhouetteParses() {
        XCTAssertFalse(CentraidCatalog.icons.isEmpty, "the emitted icon table is empty")
        for (name, paths) in CentraidCatalog.icons {
            XCTAssertFalse(paths.isEmpty, "\(name) has no paths")
            for (index, entry) in paths.enumerated() {
                XCTAssertNotNil(
                    SVGPath.parse(entry.d),
                    "\(name)[\(index)] did not parse: \(entry.d)"
                )
            }
        }
    }

    /// A parsed path has to have AREA, not merely exist.
    ///
    /// A parser that bailed after the first `moveto` would return a non-nil,
    /// empty path and satisfy the test above while drawing nothing at all.
    func testEverySilhouetteCoversTheViewBox() {
        for (name, paths) in CentraidCatalog.icons {
            let box = paths.compactMap { SVGPath.parse($0.d)?.boundingBox }
                .reduce(CGRect.null) { $0.union($1) }
            XCTAssertFalse(box.isNull, "\(name) parsed to nothing")
            // ITS LONGER SIDE, not both sides. Every shipped mark is authored
            // in a 24x24 box and spans most of one axis — but `MoreHoriz` and
            // `MoreVert` are runs of dots on a straight line, so their geometry
            // is genuinely zero-thickness and their round caps are what make
            // them visible. Asserting both sides called those two broken; a
            // mark that parsed to a single point still fails this, which is the
            // case worth catching.
            XCTAssertGreaterThan(
                max(box.width, box.height), 4,
                "\(name) spans \(box.width)x\(box.height)"
            )
            // And nothing may sit outside the box it is authored in: a mark that
            // overflows is clipped by the chip it is drawn in, which reads as a
            // broken icon rather than as a big one.
            XCTAssertGreaterThanOrEqual(box.minX, -1, "\(name) starts left of the view box")
            XCTAssertGreaterThanOrEqual(box.minY, -1, "\(name) starts above the view box")
            XCTAssertLessThanOrEqual(box.maxX, 25, "\(name) runs past the view box")
            XCTAssertLessThanOrEqual(box.maxY, 25, "\(name) runs past the view box")
        }
    }

    /// The grammar, spelled out on the shapes that broke it.
    ///
    /// These are not hypothetical: `l.1.1` is from `Settings`, the arc-flag run
    /// is from every rounded rectangle in the set, and the implicit repeat is
    /// how `Check` and the multi-segment lines are written.
    func testTheGrammarCornersTheSetActuallyUses() {
        // Two numbers, no separator, each starting with its own decimal point.
        XCTAssertEqual(SVGPath.parse("M0 0l.1.1")?.currentPoint, CGPoint(x: 0.1, y: 0.1))
        // Arc flags are ONE CHARACTER each, so `1 1-2.8` is two flags and a
        // number — reading the first as a number would swallow the rest.
        XCTAssertNotNil(SVGPath.parse("M12 12a2 2 0 1 1-2.8 2.8"))
        // A bare coordinate pair after a command repeats that command, and a
        // second pair after a `moveto` is an implicit `lineto`.
        XCTAssertEqual(SVGPath.parse("M0 0 5 5 10 10")?.currentPoint, CGPoint(x: 10, y: 10))
        // A command the grammar does not have ABORTS, rather than drawing half
        // a silhouette confidently.
        XCTAssertNil(SVGPath.parse("M0 0 Q 5 5 10 10"))
    }
}
