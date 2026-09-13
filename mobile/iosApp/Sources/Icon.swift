import CoreGraphics
import SwiftUI

/// ONE ICON SET, DRAWN FROM THE EMITTED SILHOUETTES (#1020, wave A).
///
/// The path data is `packages/design`'s, lowered by
/// `contracts/tools/export-native-catalog.ts` — the same 24×24 silhouettes the
/// web renderer and Compose draw. SF Symbols are deliberately NOT used here: a
/// second set is a second product, and Home's invariant header promises that
/// eight unlike bodies read as one grid. A `lock.fill` beside Compose's Lucide
/// lock is exactly the shells disagreeing that this wave exists to stop.
///
/// SINGLE TONE. One stroke in one colour — no duotone, no fill behind the
/// stroke, no badge. A path the data marks `filled` is filled with that same
/// colour instead of stroked, because a few silhouettes (Play, Pause) ARE their
/// fill.
struct CentraidIconView: View {
    let iconKey: String
    let tint: Color
    var size: CGFloat = 16
    var strokeWidth: CGFloat = CentraidGeometry.appMarkStroke

    var body: some View {
        Canvas { context, canvasSize in
            // The silhouettes are authored at 24; the caller draws at `size`.
            let factor = min(canvasSize.width, canvasSize.height) / CentraidGeometry.appMarkViewBox
            var transform = CGAffineTransform(scaleX: factor, y: factor)
            for entry in CentraidCatalog.icons[iconKey] ?? [] {
                guard let raw = SVGPath.parse(entry.d) else { continue }
                guard let scaled = raw.copy(using: &transform) else { continue }
                let path = Path(scaled)
                if entry.filled {
                    context.fill(path, with: .color(tint), style: FillStyle(eoFill: entry.evenOdd))
                } else {
                    context.stroke(
                        path,
                        with: .color(tint),
                        // Round caps and joins are the hand-off's, not a
                        // default: a mitred corner at 1.6 on a 16pt mark reads
                        // as a spike.
                        style: StrokeStyle(
                            lineWidth: strokeWidth,
                            lineCap: .round,
                            lineJoin: .round
                        )
                    )
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// A PARSER FOR SVG PATH DATA, because SwiftUI has none.
///
/// Compose gets this for free — `PathParser` reads the same strings the emitter
/// writes — and the alternative on this side was to lower the silhouettes into
/// 126 hand-written `Path` builders, which is a second icon set with a
/// different shape of bug. So the `d` attribute crosses unchanged and is read
/// here, once.
///
/// It implements exactly what the shipped icons use: `M m L l H h V v C c S s
/// A a Z z`. An unrecognised command ABORTS the path rather than skipping the
/// segment — half a silhouette drawn confidently is worse than none, and the
/// contract test in `packages/design` is what keeps the set inside this grammar.
enum SVGPath {
    static func parse(_ d: String) -> CGPath? {
        var scanner = Tokens(d)
        let path = CGMutablePath()
        var current = CGPoint.zero
        var start = CGPoint.zero
        // The reflection point for a smooth curve's implied first control.
        var lastControl: CGPoint?
        var command: Character?

        while let next = scanner.command(after: command) {
            command = next
            let relative = next.isLowercase
            func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
            }
            switch Character(next.lowercased()) {
            case "m":
                guard let x = scanner.number(), let y = scanner.number() else { return nil }
                current = point(x, y)
                start = current
                path.move(to: current)
                lastControl = nil
                // A second coordinate pair after a moveto is an implicit lineto.
                command = relative ? "l" : "L"
            case "l":
                guard let x = scanner.number(), let y = scanner.number() else { return nil }
                current = point(x, y)
                path.addLine(to: current)
                lastControl = nil
            case "h":
                guard let x = scanner.number() else { return nil }
                current = CGPoint(x: relative ? current.x + x : x, y: current.y)
                path.addLine(to: current)
                lastControl = nil
            case "v":
                guard let y = scanner.number() else { return nil }
                current = CGPoint(x: current.x, y: relative ? current.y + y : y)
                path.addLine(to: current)
                lastControl = nil
            case "c":
                guard let x1 = scanner.number(), let y1 = scanner.number(),
                      let x2 = scanner.number(), let y2 = scanner.number(),
                      let x = scanner.number(), let y = scanner.number() else { return nil }
                let control1 = point(x1, y1)
                let control2 = point(x2, y2)
                current = point(x, y)
                path.addCurve(to: current, control1: control1, control2: control2)
                lastControl = control2
            case "s":
                guard let x2 = scanner.number(), let y2 = scanner.number(),
                      let x = scanner.number(), let y = scanner.number() else { return nil }
                let control2 = point(x2, y2)
                let control1 = lastControl.map {
                    CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y)
                } ?? current
                current = point(x, y)
                path.addCurve(to: current, control1: control1, control2: control2)
                lastControl = control2
            case "a":
                guard let rx = scanner.number(), let ry = scanner.number(),
                      let rotation = scanner.number(), let large = scanner.flag(),
                      let sweep = scanner.flag(),
                      let x = scanner.number(), let y = scanner.number() else { return nil }
                let end = point(x, y)
                addArc(
                    to: path, from: current, to2: end,
                    rx: rx, ry: ry, rotation: rotation,
                    largeArc: large, sweep: sweep
                )
                current = end
                lastControl = nil
            case "z":
                path.closeSubpath()
                current = start
                lastControl = nil
            default:
                return nil
            }
        }
        return path.isEmpty ? nil : path
    }

    /// The endpoint parameterisation of an elliptical arc, turned into the
    /// centre parameterisation `CGPath` wants (SVG 1.1, F.6.5). Degenerate
    /// radii collapse to a straight line, which is what the spec says to do.
    private static func addArc(
        to path: CGMutablePath,
        from origin: CGPoint,
        to2 end: CGPoint,
        rx rxIn: CGFloat,
        ry ryIn: CGFloat,
        rotation degrees: CGFloat,
        largeArc: Bool,
        sweep: Bool
    ) {
        var rx = abs(rxIn)
        var ry = abs(ryIn)
        if rx == 0 || ry == 0 || (origin.x == end.x && origin.y == end.y) {
            path.addLine(to: end)
            return
        }
        let phi = degrees * .pi / 180
        let cosPhi = cos(phi)
        let sinPhi = sin(phi)
        let dx2 = (origin.x - end.x) / 2
        let dy2 = (origin.y - end.y) / 2
        let x1p = cosPhi * dx2 + sinPhi * dy2
        let y1p = -sinPhi * dx2 + cosPhi * dy2

        // Radii too small to span the chord are scaled up, never ignored.
        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if lambda > 1 {
            let scale = sqrt(lambda)
            rx *= scale
            ry *= scale
        }

        let sign: CGFloat = largeArc == sweep ? -1 : 1
        let numerator = max(
            0,
            rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
        )
        let denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p
        let coefficient = denominator == 0 ? 0 : sign * sqrt(numerator / denominator)
        let cxp = coefficient * rx * y1p / ry
        let cyp = -coefficient * ry * x1p / rx
        let cx = cosPhi * cxp - sinPhi * cyp + (origin.x + end.x) / 2
        let cy = sinPhi * cxp + cosPhi * cyp + (origin.y + end.y) / 2

        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let dot = ux * vx + uy * vy
            let len = sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy)
            let clamped = len == 0 ? 0 : min(1, max(-1, dot / len))
            let value = acos(clamped)
            return (ux * vy - uy * vx) < 0 ? -value : value
        }

        let startAngle = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
        var delta = angle(
            (x1p - cxp) / rx, (y1p - cyp) / ry,
            (-x1p - cxp) / rx, (-y1p - cyp) / ry
        )
        if !sweep, delta > 0 { delta -= 2 * .pi }
        if sweep, delta < 0 { delta += 2 * .pi }

        // `addArc` draws on a unit circle; the ellipse, its rotation and its
        // centre are the transform.
        var transform = CGAffineTransform(translationX: cx, y: cy)
            .rotated(by: phi)
            .scaledBy(x: rx, y: ry)
        path.addArc(
            center: .zero,
            radius: 1,
            startAngle: startAngle,
            endAngle: startAngle + delta,
            clockwise: delta < 0,
            transform: transform
        )
        _ = transform
    }

    /// A cursor over the `d` string.
    ///
    /// SVG path data omits a great deal: a repeated command is implicit, a
    /// separator may be a comma, a space or nothing at all, and `0 0 1` is
    /// three arc flags rather than one number. Everything the grammar allows to
    /// be left out is put back here.
    private struct Tokens {
        private let characters: [Character]
        private var index: Int = 0

        init(_ value: String) { characters = Array(value) }

        private mutating func skipSeparators() {
            while index < characters.count,
                  characters[index] == " " || characters[index] == ","
                      || characters[index] == "\n" || characters[index] == "\t"
                      || characters[index] == "\r" {
                index += 1
            }
        }

        /// The next explicit command, or `previous` repeated — which is what a
        /// bare coordinate pair after one means.
        mutating func command(after previous: Character?) -> Character? {
            skipSeparators()
            guard index < characters.count else { return nil }
            let character = characters[index]
            if character.isLetter {
                index += 1
                return character
            }
            return previous
        }

        mutating func number() -> CGFloat? {
            skipSeparators()
            var text = ""
            if index < characters.count, characters[index] == "-" || characters[index] == "+" {
                text.append(characters[index])
                index += 1
            }
            // ONE DECIMAL POINT PER NUMBER, and the second one STARTS THE NEXT.
            //
            // `l.1.1` is two numbers in SVG path data, not one malformed one —
            // the grammar lets a number end wherever it cannot continue. Reading
            // greedily made `Double(".1.1")` fail, which aborted the whole path;
            // the visible result was the Settings gear vanishing and only the
            // small circle inside it surviving, because a failed path is skipped
            // and the next one still drew.
            var seenPoint = false
            while index < characters.count {
                let character = characters[index]
                if character == "." {
                    if seenPoint { break }
                    seenPoint = true
                } else if !character.isNumber {
                    break
                }
                text.append(character)
                index += 1
            }
            // Exponents: `1e-5` is legal path data even though no shipped icon
            // uses one.
            if index < characters.count, characters[index] == "e" || characters[index] == "E" {
                text.append(characters[index])
                index += 1
                if index < characters.count, characters[index] == "-" || characters[index] == "+" {
                    text.append(characters[index])
                    index += 1
                }
                while index < characters.count, characters[index].isNumber {
                    text.append(characters[index])
                    index += 1
                }
            }
            guard let value = Double(text) else { return nil }
            return CGFloat(value)
        }

        /// An arc flag is ONE character, so `0 0 1` is three of them and
        /// `001` is too. Reading it as a number would swallow the next two.
        mutating func flag() -> Bool? {
            skipSeparators()
            guard index < characters.count else { return nil }
            let character = characters[index]
            guard character == "0" || character == "1" else { return nil }
            index += 1
            return character == "1"
        }
    }
}
