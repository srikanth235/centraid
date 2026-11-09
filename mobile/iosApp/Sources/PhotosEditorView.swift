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
    private let accent = AppAccent("photos")

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
            Surface.page.ignoresSafeArea()
            switch state.content {
            case .loading?, nil:
                // A STAGE'S OWN WORD, not a spinner: this ground is the stage.
                Text(state.words.loading)
                    .centraidType("small")
                    .foregroundStyle(Surface.meta)
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
                            .foregroundStyle(Surface.ink)
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
        .appAccent("photos")
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
            // THE TOP BAR: the way out and the commit at its ends, and between them the stamp,
            // what this is and where it came from.
            HStack(alignment: .center, spacing: 8) {
                barButton(state.words.cancel, identifier: "photos.editor.cancel", live: isEditing) {
                    send(.cancel(.init()))
                }
                Text(state.title)
                    .kitType(.row)
                    .fontWeight(.semibold)
                    .foregroundStyle(Surface.ink)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity)
                commit
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 8)

            GeometryReader { geometry in
                stage(in: geometry.size)
                    .frame(width: geometry.size.width, height: geometry.size.height)
            }
            .clipShape(RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 8)

            // THE BOARD'S LINE UNDER THE STAGE: how the crop is moved and resized.
            Text(state.words.cropHint)
                .kitType(.meta)
                .foregroundStyle(Surface.meta)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, CentraidGeometry.pageMargin)

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
            cropAccessibility(
                cropStage(preview, geometry: geometry)
            )
            .accessibilityIdentifier("photos.editor.stage")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            Text(state.saveRefusal.isEmpty ? state.words.loading : state.saveRefusal)
                .centraidType("small")
                .multilineTextAlignment(.center)
                .foregroundStyle(Surface.meta)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        #else
        EmptyView()
        #endif
    }

    #if canImport(UIKit)
    private func stageImage(_ preview: UIImage, geometry: PhotoEditGeometry) -> some View {
        let flipX: CGFloat = plan.flip == .horizontal ? -1 : 1
        let flipY: CGFloat = plan.flip == .vertical ? -1 : 1
        return Image(uiImage: preview)
            .resizable()
            .frame(width: geometry.image.width, height: geometry.image.height)
            .scaleEffect(x: flipX, y: flipY)
            .rotationEffect(.degrees(Double(rotation)))
            .accessibilityHidden(true)
    }

    private func cropStage(_ preview: UIImage, geometry: PhotoEditGeometry) -> some View {
        Color.clear
            .frame(width: geometry.frame.width, height: geometry.frame.height)
            .overlay { stageImage(preview, geometry: geometry) }
            .overlay { cropOverlay }
            .contentShape(Rectangle())
            .gesture(cropGesture(frame: geometry.frame), including: isEditing ? .all : .none)
    }
    #endif

    /// The spoken equivalents preserve every drag and pinch action while
    /// keeping accessibility and image layout as separately checked expressions.
    private func cropAccessibility<Content: View>(_ content: Content) -> some View {
        content
            .accessibilityElement()
            .accessibilityLabel(state.words.cropArea)
            .accessibilityHint(state.words.cropHint)
            .accessibilityAction(named: Text(state.words.cropLeft)) { moved(-step, 0) }
            .accessibilityAction(named: Text(state.words.cropRight)) { moved(step, 0) }
            .accessibilityAction(named: Text(state.words.cropUp)) { moved(0, -step) }
            .accessibilityAction(named: Text(state.words.cropDown)) { moved(0, step) }
            .accessibilityAction(named: Text(state.words.cropLarger)) { scaled(grow) }
            .accessibilityAction(named: Text(state.words.cropSmaller)) { scaled(1 / grow) }
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

    private func straightenCard(editing: Bool) -> some View {
        let limit = Double(max(state.straightenLimit, 1))
        let angle = Binding<Double>(
            get: { Double(plan.straighten) },
            set: { value in
                let degrees = Int32(value.rounded())
                guard editing, degrees != plan.straighten else { return }
                send(.straighten(.with { $0.degrees = degrees }))
            }
        )
        return VStack(alignment: .leading, spacing: 6) {
            Text(state.straightenLabel)
                .kitType(.row)
                .foregroundStyle(editing ? Surface.ink : Surface.meta)
            straightenSlider(angle, limit: limit)
                .tint(accent.fill)
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .disabled(!editing)
                .accessibilityLabel(state.straightenLabel)
                .accessibilityIdentifier("photos.editor.straighten")
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Surface.card, in: RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
    }

    /// THE STRAIGHTEN SLIDER fills from zero toward the thumb, as the board draws it, where the
    /// system slider of iOS 26 has a neutral value; before it, the plain slider fills from the left.
    @ViewBuilder
    private func straightenSlider(_ angle: Binding<Double>, limit: Double) -> some View {
        if #available(iOS 26, *) {
            Slider(value: angle, in: -limit...limit, step: 1, neutralValue: 0) { EmptyView() }
        } else {
            Slider(value: angle, in: -limit...limit, step: 1)
        }
    }

    private var editBar: some View {
        let editing = isEditing
        return VStack(alignment: .leading, spacing: 10) {
            // THE SHAPE, as the board draws it: one segmented control (Original, Square, 3 : 2),
            // the chosen one raised, and the sentence saying what the photograph is now.
            KitSegmented(
                options: state.ratios.map { (key: $0.ratio, label: $0.label) },
                selected: state.ratios.first(where: \.selected)?.ratio ?? .original,
                identifier: "photos.editor.ratio",
                fills: true
            ) { ratio in
                guard editing else { return }
                send(.ratio(.with {
                    $0.ratio = ratio
                    $0.frameRatio = frameRatio
                }))
            }
            .disabled(!editing)
            if !state.statusLine.isEmpty {
                Text(state.statusLine)
                    .kitType(.row)
                    .fontWeight(.semibold)
                    .foregroundStyle(Surface.ink)
                    .accessibilityIdentifier("photos.editor.status")
            }
            // STRAIGHTEN IS A SLIDER on a card of its own, as the board draws it: the angle in
            // whole degrees either side of level, to the limit Rust states. Every whole degree
            // is one `straighten` event carrying the angle; Rust clamps and keeps it.
            straightenCard(editing: editing)
            // THE THREE KEYS, equal and white: turn, mirror, start over.
            HStack(spacing: 8) {
                tool(state.words.rotate, enabled: editing) { send(.rotate(.init())) }
                tool(state.flipLabel, selected: plan.flip != .unspecified, enabled: editing) {
                    send(.flip(.init()))
                }
                tool(state.words.reset, enabled: editing && state.edited) { send(.reset(.init())) }
            }
            Text(state.words.saveExplanation)
                .kitType(.meta)
                .foregroundStyle(Surface.meta)
            // WHERE IT CAME FROM, the board's last line.
            if case let .data(data)? = state.content, !data.meta.isEmpty {
                Text(data.meta)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
            }
            // THE REFUSAL IS VISIBLE TEXT, never only an accessibility hint, and
            // a save that did not land says so in the same place.
            if let refusal = refusalLine {
                Text(refusal)
                    .centraidType("small")
                    .foregroundStyle(Surface.ink)
                    .accessibilityIdentifier("photos.editor.refusal")
            }
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
        return Button {
            guard live else { return }
            send(.save(.init()))
        } label: {
            Text(state.words.save)
                .kitType(.row)
                .fontWeight(.semibold)
                .foregroundStyle(live ? Color.white : Surface.meta)
                .padding(.horizontal, 16)
                .frame(minHeight: 44)
                .background(live ? accent.fill : Surface.fill, in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!live)
        .accessibilityLabel(state.words.save)
        .accessibilityHint(state.saveRefusal)
        .accessibilityIdentifier("photos.editor.save")
    }

    /// THE WAY OUT: a round key with an X in glass, Cancel's word for a screen reader. Cancel
    /// asks first when there is something to lose, so it is the same event.
    private func barButton(_ label: String, identifier: String, live: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            CentraidIconView(iconKey: "X", tint: live ? Surface.ink : Surface.meta, size: 18)
                .frame(width: 44, height: 44)
                .background(Surface.card, in: Circle())
                .overlay(Circle().strokeBorder(Surface.border, lineWidth: CentraidGeometry.hairline))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!live)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    private func tool(
        _ label: String,
        selected: Bool = false,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        let shape = RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous)
        return Button {
            guard enabled else { return }
            action()
        } label: {
            Text(label)
                .kitType(.meta)
                .fontWeight(.semibold)
                .foregroundStyle(selected ? Color.white : (enabled ? Surface.ink : Surface.meta))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .padding(.horizontal, 6)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(selected ? accent.fill : Surface.card, in: shape)
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
