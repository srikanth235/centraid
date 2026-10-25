import Foundation
import ImageIO
import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

/// THE PHOTO EDITOR — crop, rotate, straighten, flip (#1135): `photos.editor`,
/// drawn. The Compose twin is `PhotosEditorScreen.kt`. Everything this view
/// SAYS is Rust's (the status line, the two live labels, the refusal, the ratio
/// names), and everything it DRAWS is the plan on the state. What is this file's
/// own is the GEOMETRY of the stage and the gesture's translation into
/// fractions: Rust has no image and cannot know how wide the frame is.
///
/// **Nothing is written until "Save new photo".** Every control here sends a plan
/// change; only the commit sends `save`, and only Rust turns that into a render
/// (`RenderEdit`, performed by `PhotoEffects`).
struct PhotosEditorView: View {
    @Environment(\.colorScheme) private var scheme

    let state: Centraid_Core_V1_PhotosEditorState
    let send: (Centraid_Core_V1_PhotosEditorEvent.OneOf_Kind) -> Void

    /// The member left without saving. The shell pops.
    var onClose: () -> Void = {}

    /// The new photograph is in the vault. The shell pops and opens it.
    var onSaved: (Centraid_Core_V1_Route) -> Void = { _ in }

    /// THE STAGE'S DECODE, and only the stage's: a stage-sized, oriented copy.
    /// View state because it is a rendering cache and not a fact about the edit.
    #if canImport(UIKit)
    @State private var preview: UIImage?
    #endif

    /// The drag's last translation, so each change is sent as a DELTA.
    @State private var lastDrag: CGSize = .zero

    private var plan: Centraid_Core_V1_PhotosEditPlan { state.plan }
    private var isEditing: Bool { state.phase == .editing }
    private var rotation: Int { Int(plan.quarters % 4) * 90 + Int(plan.straighten) }

    var body: some View {
        ZStack {
            Theme.color("stage", scheme).ignoresSafeArea()
            switch state.content {
            case .loading?, nil:
                // A STAGE'S OWN WORD, not a spinner: this ground is the stage.
                Text(state.words.loading)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("onStageSoft", scheme))
            case let .denied(denied)?:
                DeniedGate(denied)
            case let .failure(failure)?:
                VStack(spacing: 12) {
                    ScreenFailureView(sentence: failure.sentence, remedy: failure.remedy)
                    Button {
                        send(.cancel(.init()))
                    } label: {
                        Text(state.words.cancel)
                            .centraidType("control")
                            .foregroundStyle(Theme.color("onStage", scheme))
                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .padding(CentraidGeometry.pageMargin)
            case let .data(data)?:
                editor(data)
            }
        }
        // A STAGE HAS NO HEADER, and the system back is not a way out of an edit:
        // Cancel is, because Cancel asks first when there is something to lose.
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        .sheet(
            isPresented: Binding(
                get: { state.hasDiscard },
                set: { open in if !open, state.hasDiscard { send(.discard(.with { $0.discard = false })) } }
            )
        ) {
            ConfirmSheet(
                state.discard,
                cancelLabel: state.words.cancel,
                onConfirm: { send(.discard(.with { $0.discard = true })) },
                onDismiss: { send(.discard(.with { $0.discard = false })) }
            )
        }
        // RUST SAYS WHEN TO LEAVE; the shell does the leaving.
        .onChange(of: state.dismissed) { _, gone in
            guard gone else { return }
            if state.hasSavedRoute { onSaved(state.savedRoute) } else { onClose() }
        }
    }

    // MARK: - The editor

    @ViewBuilder
    private func editor(_ data: Centraid_Core_V1_PhotosEditorData) -> some View {
        VStack(spacing: 8) {
            // THE STAMP: what this is and where it came from.
            VStack(spacing: 2) {
                Text(state.title).centraidType("control")
                    .foregroundStyle(Theme.color("onStage", scheme))
                Text(data.meta).centraidType("small")
                    .foregroundStyle(Theme.color("onStageSoft", scheme))
            }
            .padding(.top, 8)

            GeometryReader { geometry in
                stage(in: geometry.size)
                    .frame(width: geometry.size.width, height: geometry.size.height)
            }
            .padding(CentraidGeometry.pageMargin)

            editBar
        }
        .task(id: stagePath(data)) { await loadPreview(stagePath(data)) }
    }

    /// The original when it is here (it is what Save renders), else the
    /// thumbnail, so the stage is never a broken image.
    private func stagePath(_ data: Centraid_Core_V1_PhotosEditorData) -> String? {
        if !data.originalPath.isEmpty { return data.originalPath }
        if data.hasTile, data.tile.hasThumbnailPath, !data.tile.thumbnailPath.isEmpty {
            return data.tile.thumbnailPath
        }
        return nil
    }

    /// THE PHOTOGRAPH, ITS FRAME AND THE CROP OVER IT. The frame is the ROTATED
    /// box fitted into the space: straighten grows it rather than swapping its
    /// sides, and the crop is in fractions of it. The image is drawn at its
    /// unrotated size and turned about its centre, FLIP FIRST AND ROTATION SECOND,
    /// the order `PhotoEditRenderer` draws in, so the stage and the saved pixels
    /// are one picture.
    @ViewBuilder
    private func stage(in space: CGSize) -> some View {
        #if canImport(UIKit)
        if let preview, preview.size.height > 0 {
            let geometry = PhotoEditGeometry(
                sourceRatio: preview.size.width / preview.size.height,
                rotation: rotation,
                space: space
            )
            Color.clear
                .frame(width: geometry.frame.width, height: geometry.frame.height)
                .overlay {
                    Image(uiImage: preview)
                        .resizable()
                        .frame(width: geometry.image.width, height: geometry.image.height)
                        .scaleEffect(x: plan.flip == .horizontal ? -1 : 1, y: plan.flip == .vertical ? -1 : 1)
                        .rotationEffect(.degrees(Double(rotation)))
                        .accessibilityHidden(true)
                }
                .overlay { cropOverlay }
                .contentShape(Rectangle())
                .gesture(cropGesture(frame: geometry.frame), including: isEditing ? .all : .none)
                .accessibilityElement()
                .accessibilityLabel(state.words.cropArea)
                .accessibilityHint(state.words.cropHint)
                // NOTHING IS REACHABLE BY GESTURE ALONE. The drag and the pinch
                // have spoken equivalents, one step at a time.
                .accessibilityAction(named: state.words.cropLeft) { moved(-step, 0) }
                .accessibilityAction(named: state.words.cropRight) { moved(step, 0) }
                .accessibilityAction(named: state.words.cropUp) { moved(0, -step) }
                .accessibilityAction(named: state.words.cropDown) { moved(0, step) }
                .accessibilityAction(named: state.words.cropLarger) { scaled(grow) }
                .accessibilityAction(named: state.words.cropSmaller) { scaled(1 / grow) }
                .accessibilityIdentifier("photos.editor.stage")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            Text(state.saveRefusal.isEmpty ? state.words.loading : state.saveRefusal)
                .centraidType("small")
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.color("onStageSoft", scheme))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        #else
        EmptyView()
        #endif
    }

    private var cropOverlay: some View {
        let crop = plan.hasCrop ? (CGFloat(plan.crop.x), CGFloat(plan.crop.y), CGFloat(plan.crop.w), CGFloat(plan.crop.h))
            : (0, 0, 1, 1)
        let mask = Theme.color("stage", scheme).opacity(maskAlpha)
        let thirds = Theme.color("stageLine", scheme)
        let ink = Theme.color("onStage", scheme)
        return Canvas { context, size in
            let box = CGRect(
                x: crop.0 * size.width,
                y: crop.1 * size.height,
                width: crop.2 * size.width,
                height: crop.3 * size.height
            )
            var outside = Path(CGRect(origin: .zero, size: size))
            outside.addRect(box)
            context.fill(outside, with: .color(mask), style: FillStyle(eoFill: true))
            var grid = Path()
            for step in 1...2 {
                let x = box.minX + box.width * CGFloat(step) / 3
                let y = box.minY + box.height * CGFloat(step) / 3
                grid.move(to: CGPoint(x: x, y: box.minY))
                grid.addLine(to: CGPoint(x: x, y: box.maxY))
                grid.move(to: CGPoint(x: box.minX, y: y))
                grid.addLine(to: CGPoint(x: box.maxX, y: y))
            }
            context.stroke(grid, with: .color(thirds), lineWidth: 1)
            context.stroke(Path(box), with: .color(ink), lineWidth: 1)
        }
        .allowsHitTesting(false)
    }

    private func moved(_ dx: Double, _ dy: Double) {
        send(.cropMoved(.with {
            $0.dx = dx
            $0.dy = dy
        }))
    }

    private func scaled(_ factor: Double) {
        send(.cropScaled(.with { $0.factor = factor }))
    }

    private func cropGesture(frame: CGSize) -> some Gesture {
        let drag = DragGesture(minimumDistance: 4)
            .onChanged { value in
                guard frame.width > 0, frame.height > 0 else { return }
                let dx = value.translation.width - lastDrag.width
                let dy = value.translation.height - lastDrag.height
                lastDrag = value.translation
                moved(dx / frame.width, dy / frame.height)
            }
            .onEnded { _ in lastDrag = .zero }
        // ONCE PER PINCH, with the total factor: rescaling per frame drifts.
        // Pinching apart shrinks the crop's share of the frame, so it is inverted.
        let pinch = MagnifyGesture()
            .onEnded { value in
                if value.magnification > 0 { scaled(1 / value.magnification) }
            }
        return drag.simultaneously(with: pinch)
    }

    // MARK: - The bar

    private var editBar: some View {
        let editing = isEditing
        return VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    // "CROP" IS ALWAYS SELECTED: it is the mode this editor is in,
                    // and pressing it returns the crop to the whole frame.
                    tool(state.words.crop, selected: true, enabled: editing) {
                        send(.ratio(.with {
                            $0.ratio = .original
                            $0.frameRatio = 0
                        }))
                    }
                    tool(state.words.rotate, enabled: editing) { send(.rotate(.init())) }
                    tool(state.straightenLabel, enabled: editing) { send(.straighten(.init())) }
                    tool(state.flipLabel, selected: plan.flip != .unspecified, enabled: editing) {
                        send(.flip(.init()))
                    }
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(state.ratios, id: \.ratio.rawValue) { ratio in
                        // ORIGINAL IS NEVER DRAWN SELECTED, as in v0: it is the
                        // absence of a ratio.
                        tool(
                            ratio.label,
                            selected: ratio.selected && ratio.ratio != .original,
                            enabled: editing
                        ) {
                            send(.ratio(.with {
                                $0.ratio = ratio.ratio
                                $0.frameRatio = frameRatio
                            }))
                        }
                    }
                    tool(state.words.reset, enabled: editing && state.edited) { send(.reset(.init())) }
                }
            }
            Text(state.words.saveExplanation)
                .centraidType("small")
                .foregroundStyle(Theme.color("onStageSoft", scheme))
            HStack(spacing: 8) {
                tool(state.words.cancel, enabled: editing) { send(.cancel(.init())) }
                commit
            }
            // THE REFUSAL IS VISIBLE TEXT, never only an accessibility hint, and
            // a save that did not land says so in the same place.
            if let refusal = refusalLine {
                Text(refusal)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("onStage", scheme))
                    .accessibilityIdentifier("photos.editor.refusal")
            }
            // THE ONE STATUS LINE.
            Text(state.statusLine)
                .centraidType("mono")
                .foregroundStyle(Theme.color("onStageSoft", scheme))
                .accessibilityIdentifier("photos.editor.status")
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.bottom, 8)
    }

    private var refusalLine: String? {
        if state.hasSaveFailure, !state.saveFailure.sentence.isEmpty {
            return [state.saveFailure.sentence, state.saveFailure.remedy]
                .filter { !$0.isEmpty }
                .joined(separator: " ")
        }
        return state.saveRefusal.isEmpty ? nil : state.saveRefusal
    }

    private var commit: some View {
        let live = isEditing && state.saveRefusal.isEmpty
        let shape = RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
        return Button {
            guard live else { return }
            send(.save(.init()))
        } label: {
            Text(state.words.save)
                .centraidType("control")
                .foregroundStyle(Theme.color(live ? "stage" : "onStageSoft", scheme))
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(live ? Theme.color("onStage", scheme) : Color.clear, in: shape)
                .overlay(shape.strokeBorder(Theme.color(live ? "onStage" : "stageLine", scheme), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(!live)
        .accessibilityLabel(state.words.save)
        .accessibilityHint(state.saveRefusal)
        .accessibilityIdentifier("photos.editor.save")
    }

    private func tool(
        _ label: String,
        selected: Bool = false,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        let shape = RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
        return Button {
            guard enabled else { return }
            action()
        } label: {
            Text(label)
                .centraidType("control")
                .foregroundStyle(Theme.color(enabled ? "onStage" : "onStageSoft", scheme))
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .overlay(
                    shape.strokeBorder(
                        Theme.color(selected ? "onStage" : "stageLine", scheme),
                        lineWidth: 1
                    )
                )
                .contentShape(shape)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: - The preview

    /// THE ROTATED FRAME'S SHAPE, for a centred ratio crop. The stage is the one
    /// thing that has measured the photograph, oriented, as drawn; zero before the
    /// preview lands, which Rust answers with the whole frame.
    private var frameRatio: Double {
        #if canImport(UIKit)
        guard let preview, preview.size.height > 0 else { return 0 }
        return PhotoEditGeometry.rotatedFrameRatio(
            Double(preview.size.width / preview.size.height),
            degrees: rotation
        )
        #else
        return 0
        #endif
    }

    private func loadPreview(_ path: String?) async {
        #if canImport(UIKit)
        guard let path else {
            preview = nil
            return
        }
        preview = await Task.detached(priority: .userInitiated) {
            PhotoEditRenderer.preview(path: path)
        }.value
        #endif
    }

    /// One spoken step of the crop: a twentieth of the frame. One spoken pinch.
    private let step = 0.05
    private let grow = 1.1
    /// v0's `maskFill`: the stage colour at `8C`.
    private let maskAlpha = Double(0x8C) / 255
}

/// THE FRAME AND THE IMAGE IN IT: layout only. The rotated box grows with a
/// straighten; the plan itself is Rust's.
struct PhotoEditGeometry {
    let frame: CGSize
    let image: CGSize

    init(sourceRatio: CGFloat, rotation: Int, space: CGSize) {
        let frameRatio = CGFloat(Self.rotatedFrameRatio(Double(sourceRatio), degrees: rotation))
        if space.height > 0, space.width / space.height > frameRatio {
            frame = CGSize(width: space.height * frameRatio, height: space.height)
        } else {
            frame = CGSize(width: space.width, height: frameRatio > 0 ? space.width / frameRatio : 0)
        }
        let boxWidth = Self.rotatedBox(width: Double(sourceRatio), height: 1, degrees: rotation).0
        let scale = boxWidth > 0 ? frame.width / CGFloat(boxWidth) : 0
        image = CGSize(width: sourceRatio * scale, height: scale)
    }

    static func rotatedBox(width: Double, height: Double, degrees: Int) -> (Double, Double) {
        let radians = Double(degrees) * .pi / 180
        let c = abs(cos(radians))
        let s = abs(sin(radians))
        return (width * c + height * s, width * s + height * c)
    }

    static func rotatedFrameRatio(_ ratio: Double, degrees: Int) -> Double {
        let box = rotatedBox(width: ratio, height: 1, degrees: degrees)
        return box.1 > 0 ? box.0 / box.1 : ratio
    }
}
