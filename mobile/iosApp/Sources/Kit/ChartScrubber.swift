import SwiftUI

/// The selection and its spoken value belong to the core; the native slider
/// supplies keyboard, touch and VoiceOver adjustment over the chart's buckets.
struct ChartScrubber: View {
    let label: String
    let valueLabel: String
    let index: UInt32
    let count: Int
    let onSelect: (UInt32) -> Void

    var body: some View {
        if count > 1 {
            Slider(
                value: Binding(get: { Double(index) }, set: { onSelect(UInt32($0.rounded())) }),
                in: 0...Double(count - 1),
                step: 1
            ) {
                Text(label)
            }
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .accessibilityValue(valueLabel)
            .accessibilityIdentifier("health-metric-scrubber")
        }
    }
}
