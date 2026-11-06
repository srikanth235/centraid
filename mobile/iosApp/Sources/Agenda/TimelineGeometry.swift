import Foundation

/// Measured layout only: Rust supplies civil offsets and the adjustment step.
struct TimelineSpan {
    let start: Int64
    let end: Int64
    let minimumHeight: Double
}

struct TimelineGeometry {
    private let times: [Double]
    private let positions: [Double]
    var height: Double { positions.last ?? 0 }

    init(duration: Int64, hourOffsets: [Int64], spans: [TimelineSpan], hourHeight: Double) {
        let points = [Int64(0), duration] + hourOffsets + spans.flatMap { [$0.start, $0.end] }
        let times = Set(points).sorted().map(Double.init)
        var heights = zip(times, times.dropFirst()).map { pair in (pair.1 - pair.0) / 3_600_000 * hourHeight }
        for span in spans {
            guard let first = times.firstIndex(of: Double(span.start)) else { continue }
            let last = span.end > span.start ? (times.firstIndex(of: Double(span.end)) ?? first) : min(first + 1, times.count - 1)
            guard last > first else { continue }
            let current = heights[first..<last].reduce(0, +)
            let extra = max(0, span.minimumHeight - current)
            let elapsed = times[last] - times[first]
            for index in first..<last { heights[index] += extra * (times[index + 1] - times[index]) / elapsed }
        }
        var positions = [0.0]
        for height in heights { positions.append((positions.last ?? 0) + height) }
        self.times = times
        self.positions = positions
    }

    func y(_ time: Int64) -> Double { interpolate(Double(time), from: times, to: positions) }

    func delta(anchor: Int64, translation: Double, stepMinutes: Int32) -> Int32 {
        guard stepMinutes > 0 else { return 0 }
        let moved = interpolate(y(anchor) + translation, from: positions, to: times)
        return Int32(((moved - Double(anchor)) / 60_000 / Double(stepMinutes)).rounded()) * stepMinutes
    }

    private func interpolate(_ value: Double, from: [Double], to: [Double]) -> Double {
        guard from.count > 1 else { return 0 }
        let index = min(max((from.firstIndex(where: { $0 > value }) ?? (from.count - 1)) - 1, 0), from.count - 2)
        let fraction = (value - from[index]) / (from[index + 1] - from[index])
        return to[index] + fraction * (to[index + 1] - to[index])
    }
}
