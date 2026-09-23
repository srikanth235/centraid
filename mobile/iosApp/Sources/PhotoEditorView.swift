import Foundation
import ImageIO
import SwiftProtobuf
import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

/// THE PHOTO EDITOR — crop, rotate, straighten, flip (#1029, photos port).
///
/// The Compose twin is `screens/PhotoEditorScreen.kt`; the two are kept in step
/// by hand. Everything this view SAYS is reduced by `PhotoEditorMachine` — the
/// status line, the two live labels, the refusal — and everything it DRAWS is
/// the plan on that state. What is this file's own is the GEOMETRY of the stage
/// and the gesture's translation into fractions: the reducer has no image and
/// cannot know how wide the frame is.
///
/// ## Mode, not a page
///
/// v0's editor was a mode over the lightbox, so the photograph never unmounted.
/// It is a route here because it has a machine of its own, and it keeps the
/// mode's promise another way: the lightbox stays under it on the stack, and
/// Cancel lands on the same photograph.
///
/// ## The one promise
///
/// **Nothing is written until "Save as a new photograph".** Every control here
/// sends a plan change; only the commit sends `save`, and only the machine
/// turns that into a render.
struct PhotoEditorView: View {
    @Environment(\.colorScheme) private var scheme

    /// The encoded `PhotoEditorState` the bridge published.
    let data: Data

    /// One encoded `PhotoEditorEvent`, back to the bridge.
    let send: (Data) -> Void

    /// The member left without saving. The shell pops.
    var onClose: () -> Void = {}

    /// The new photograph is in the vault. The shell opens it.
    var onSaved: (String) -> Void = { _ in }

    /// THE STAGE'S DECODE, and only the stage's: a stage-sized, oriented copy.
    /// View state because it is a rendering cache and not a fact about the
    /// edit — the full original is decoded only by `PhotoEditRenderer`.
    #if canImport(UIKit)
    @State private var preview: UIImage?
    #endif

    /// The drag's last translation, so each change is sent as a DELTA.
    @State private var lastDrag: CGSize = .zero

    private var state: PhotoEditorStateView { PhotoEditorStateView(data: data) }

    var body: some View {
        ZStack {
            Theme.color("stage", scheme).ignoresSafeArea()
            switch state.content {
            case .loading:
                ProgressView()
            case let .failure(sentence, remedy):
                VStack(spacing: 12) {
                    ScreenFailureView(sentence: sentence, remedy: remedy)
                    Button(PhotoEditorStateView.cancelWord) { send(state.cancelEvent) }
                        .centraidType("control")
                        .foregroundStyle(Theme.color("onStage", scheme))
                }
                .padding(CentraidGeometry.pageMargin)
            case let .data(source):
                editor(source)
            }
        }
        // A STAGE HAS NO HEADER, and the system back is not a way out of an
        // edit: Cancel is, because Cancel asks first when there is something
        // to lose. Hiding the bar takes the swipe-back with it.
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        .confirmationDialog(
            PhotoEditorStateView.discardQuestion,
            isPresented: Binding(
                get: { state.discardOpen },
                set: { open in if !open, state.discardOpen { send(state.discardEvent(false)) } }
            ),
            titleVisibility: .visible
        ) {
            Button(PhotoEditorStateView.discardWord, role: .destructive) {
                send(state.discardEvent(true))
            }
            Button(PhotoEditorStateView.keepEditingWord, role: .cancel) {
                send(state.discardEvent(false))
            }
        }
        // THE MACHINE SAYS WHEN TO LEAVE; the shell does the leaving.
        .onChange(of: state.phase) { _, phase in
            switch phase {
            case .saved: onSaved(state.savedAssetID)
            case .closed: onClose()
            default: break
            }
        }
    }

    // MARK: - The editor

    @ViewBuilder
    private func editor(_ source: Centraid_Screen_V1_PhotoEditSource) -> some View {
        VStack(spacing: 8) {
            // THE STAMP: what this is and where it came from.
            VStack(spacing: 2) {
                Text(PhotoEditorStateView.title).centraidType("control")
                    .foregroundStyle(Theme.color("onStage", scheme))
                Text(PhotoEditorStateView.meta(source.capturedAt, offsetMinutes: source.hasCapturedUtcOffsetMinutes ? Int(source.capturedUtcOffsetMinutes) : 0)).centraidType("small")
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
        .task(id: state.stagePath) { await loadPreview(state.stagePath) }
    }

    /// THE PHOTOGRAPH, ITS FRAME AND THE CROP OVER IT.
    ///
    /// The frame is the ROTATED box fitted into the space: straighten grows it
    /// rather than swapping its sides, and the crop is in fractions of it. The
    /// image is drawn at its unrotated size and turned about its centre, FLIP
    /// FIRST AND ROTATION SECOND — the order `PhotoEditRenderer` draws in, so
    /// the stage and the saved pixels are one picture.
    @ViewBuilder
    private func stage(in space: CGSize) -> some View {
        #if canImport(UIKit)
        if let preview, preview.size.height > 0 {
            let geometry = PhotoEditGeometry(
                sourceRatio: preview.size.width / preview.size.height,
                rotation: state.rotation,
                space: space
            )
            Color.clear
                .frame(width: geometry.frame.width, height: geometry.frame.height)
                .overlay {
                    Image(uiImage: preview)
                        .resizable()
                        .frame(width: geometry.image.width, height: geometry.image.height)
                        .scaleEffect(x: state.flipX, y: state.flipY)
                        .rotationEffect(.degrees(Double(state.rotation)))
                        .accessibilityHidden(true)
                }
                .overlay { cropOverlay }
                .contentShape(Rectangle())
                .gesture(cropGesture(frame: geometry.frame), including: state.isEditing ? .all : .none)
                .accessibilityElement()
                .accessibilityLabel("Crop area")
                .accessibilityHint("Drag to move the crop, pinch to resize it")
                // NOTHING IS REACHABLE BY GESTURE ALONE (§15). The drag and the
                // pinch have spoken equivalents, one step at a time.
                .accessibilityAction(named: "Move crop left") { send(state.movedEvent(-step, 0)) }
                .accessibilityAction(named: "Move crop right") { send(state.movedEvent(step, 0)) }
                .accessibilityAction(named: "Move crop up") { send(state.movedEvent(0, -step)) }
                .accessibilityAction(named: "Move crop down") { send(state.movedEvent(0, step)) }
                .accessibilityAction(named: "Make crop larger") { send(state.scaledEvent(grow)) }
                .accessibilityAction(named: "Make crop smaller") { send(state.scaledEvent(1 / grow)) }
                .accessibilityIdentifier("photos.editor.stage")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            Text(state.stagePath == nil
                ? "This photograph is not on this device yet."
                : PhotoEditorStateView.title)
                .centraidType("small")
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.color("onStageSoft", scheme))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        #else
        EmptyView()
        #endif
    }

    /// FOUR PANES' WORTH OF MASK, the thirds, and the box. The mask is the
    /// STAGE colour with alpha on the colour — v0's `maskFill` — never opacity
    /// on a container.
    private var cropOverlay: some View {
        let crop = state.crop
        let mask = Theme.color("stage", scheme).opacity(maskAlpha)
        let thirds = Theme.color("stageLine", scheme)
        let ink = Theme.color("onStage", scheme)
        return Canvas { context, size in
            let box = CGRect(
                x: crop.x * size.width,
                y: crop.y * size.height,
                width: crop.w * size.width,
                height: crop.h * size.height
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

    /// v0's `buildCropGesture`: a drag moves the box, continuously, in
    /// FRACTIONS of the frame; a pinch scales it ONCE, with its total factor,
    /// because rescaling per frame drifts. Pinching apart shrinks the box's
    /// share of the frame, so the factor is inverted.
    private func cropGesture(frame: CGSize) -> some Gesture {
        let drag = DragGesture(minimumDistance: 4)
            .onChanged { value in
                guard frame.width > 0, frame.height > 0 else { return }
                let dx = value.translation.width - lastDrag.width
                let dy = value.translation.height - lastDrag.height
                lastDrag = value.translation
                send(state.movedEvent(dx / frame.width, dy / frame.height))
            }
            .onEnded { _ in lastDrag = .zero }
        let pinch = MagnifyGesture()
            .onEnded { value in
                if value.magnification > 0 { send(state.scaledEvent(1 / value.magnification)) }
            }
        return drag.simultaneously(with: pinch)
    }

    // MARK: - The bar

    /// TOOLS, SENTENCE AND COMMITS SHARE THIS BAR — v0's `editBar`.
    ///
    /// Two rows that scroll sideways rather than one that wraps: the
    /// transforms and the ratios are two questions, and a row that reflows as
    /// "Straighten 0°" becomes "Straighten −12°" moves under the thumb.
    private var editBar: some View {
        let editing = state.isEditing
        return VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    // "CROP" IS ALWAYS SELECTED: it is the mode this editor is
                    // in, and pressing it returns the crop to the whole frame.
                    tool("Crop", selected: true, enabled: editing) {
                        send(state.ratioEvent(.original, frameRatio: 0))
                    }
                    tool("Rotate 90°", enabled: editing) { send(state.rotateEvent) }
                    tool(state.straightenLabel, enabled: editing) { send(state.straightenEvent) }
                    tool(state.flipLabel, selected: state.isFlipped, enabled: editing) {
                        send(state.flipEvent)
                    }
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(PhotoEditorStateView.ratios, id: \.self) { ratio in
                        // ORIGINAL IS NEVER DRAWN SELECTED, as in v0: it is the
                        // absence of a ratio.
                        tool(
                            PhotoEditorStateView.ratioName(ratio),
                            selected: state.ratio == ratio && ratio != .original,
                            enabled: editing
                        ) {
                            send(state.ratioEvent(ratio, frameRatio: frameRatio))
                        }
                    }
                    tool("Reset", enabled: editing && state.edited) { send(state.resetEvent) }
                }
            }
            Text(PhotoEditorStateView.explanation)
                .centraidType("small")
                .foregroundStyle(Theme.color("onStageSoft", scheme))
            HStack(spacing: 8) {
                tool(PhotoEditorStateView.cancelWord, enabled: editing) { send(state.cancelEvent) }
                commit
            }
            // THE REFUSAL IS VISIBLE TEXT, never only an accessibility hint —
            // and a save that did not land says so in the same place.
            if let refusal = state.refusalLine {
                Text(refusal)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("onStage", scheme))
                    .accessibilityIdentifier("photos.editor.refusal")
            }
            // THE ONE STATUS LINE: "nothing written yet" until something is.
            Text(state.statusLine)
                .centraidType("mono")
                .foregroundStyle(Theme.color("onStageSoft", scheme))
                .accessibilityIdentifier("photos.editor.status")
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.bottom, 8)
    }

    /// THE ONE FILLED ELEMENT. A commit that cannot fire is OUTLINED, never a
    /// dimmed fill (DESIGN.md invariant 3), and says why beneath.
    private var commit: some View {
        let live = state.isEditing && state.saveRefusal.isEmpty
        let shape = RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
        return Button {
            guard live else { return }
            send(state.saveEvent)
        } label: {
            Text(PhotoEditorStateView.saveWord)
                .centraidType("control")
                .foregroundStyle(Theme.color(live ? "stage" : "onStageSoft", scheme))
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(live ? Theme.color("onStage", scheme) : Color.clear, in: shape)
                .overlay(shape.strokeBorder(Theme.color(live ? "onStage" : "stageLine", scheme), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(!live)
        .accessibilityLabel(PhotoEditorStateView.saveWord)
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

    /// THE ROTATED FRAME'S SHAPE, for a centred ratio crop — measured off the
    /// stage's own decode, because the reducer has no image. Zero before it
    /// lands, which the reducer answers with the whole frame.
    private var frameRatio: Double {
        #if canImport(UIKit)
        guard let preview, preview.size.height > 0 else { return 0 }
        return PhotoEditGeometry.rotatedFrameRatio(
            Double(preview.size.width / preview.size.height),
            degrees: state.rotation
        )
        #else
        return 0
        #endif
    }

    /// A stage-sized decode, ORIENTED — ImageIO's thumbnail with the transform
    /// applied, so a sideways-stored photograph stands up exactly as the
    /// renderer will stand it up.
    ///
    /// OFF THE MAIN THREAD: a decode of a full-size original, even to a
    /// stage-sized copy, is tens of milliseconds a scroll would feel.
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

    private let step = 0.05
    private let grow = 1.1
    /// v0's `maskFill`: the stage colour at `8C`.
    private let maskAlpha = Double(0x8C) / 255
}

/// The frame, fitted, and the image inside it. v0's `rotatedBox` and
/// `fitMedia`, ported with `PhotoEditorMachine`'s geometry — mirrored here
/// rather than called across the Kotlin boundary, as the lightbox mirrors its
/// share rows.
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
        let box = Self.rotatedBox(width: Double(sourceRatio), height: 1, degrees: rotation)
        let scale = box.width > 0 ? frame.width / CGFloat(box.width) : 0
        image = CGSize(width: sourceRatio * scale, height: scale)
    }

    static func rotatedBox(width: Double, height: Double, degrees: Int) -> (width: Double, height: Double) {
        let radians = Double(degrees) * .pi / 180
        let c = abs(cos(radians))
        let s = abs(sin(radians))
        return (width * c + height * s, width * s + height * c)
    }

    static func rotatedFrameRatio(_ ratio: Double, degrees: Int) -> Double {
        let box = rotatedBox(width: ratio, height: 1, degrees: degrees)
        return box.height > 0 ? box.width / box.height : ratio
    }
}

/// The decoder between the editor's bytes and the view above. Its own struct
/// in its own file, for `PhotoLightboxStateView`'s reason: `StateViews.swift`
/// is shared by every lane.
struct PhotoEditorStateView {
    let data: Data

    private var state: Centraid_Screen_V1_PhotoEditorState {
        (try? Centraid_Screen_V1_PhotoEditorState(serializedBytes: data)) ?? .init()
    }

    /// Loading, a failure with a sentence, or the photograph — and a message
    /// with no content set is the SAME screen as loading.
    var content: ScreenContent<Centraid_Screen_V1_PhotoEditSource> {
        switch state.content {
        case let .failure(failure): return .failure(failure.sentence, failure.remedy)
        case let .source(source): return .data(source)
        case let .loading(loading): return .loading(loading.firstLoad)
        case .none: return .loading(true)
        }
    }

    private var plan: Centraid_Screen_V1_PhotoEditPlan { state.plan }
    var phase: Centraid_Screen_V1_PhotoEditorState.Phase { state.phase }
    var isEditing: Bool { state.phase == .editing }
    var statusLine: String { state.statusLine }
    var straightenLabel: String { state.straightenLabel }
    var flipLabel: String { state.flipLabel }
    var edited: Bool { state.edited }
    var saveRefusal: String { state.saveRefusal }
    var discardOpen: Bool { state.discardOpen }
    var savedAssetID: String { state.savedAssetID }
    var ratio: Centraid_Screen_V1_PhotoEditPlan.Ratio {
        plan.ratio == .unspecified ? .original : plan.ratio
    }
    var isFlipped: Bool { plan.flip != .unspecified }
    var flipX: CGFloat { plan.flip == .horizontal ? -1 : 1 }
    var flipY: CGFloat { plan.flip == .vertical ? -1 : 1 }

    /// Quarter turns plus the levelling, in degrees clockwise.
    var rotation: Int { Int(plan.quarters % 4) * 90 + Int(plan.straighten) }

    var crop: (x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat) {
        guard plan.hasCrop else { return (0, 0, 1, 1) }
        return (CGFloat(plan.crop.x), CGFloat(plan.crop.y), CGFloat(plan.crop.w), CGFloat(plan.crop.h))
    }

    /// The original when this phone holds it — it is what Save renders — and
    /// the thumbnail when it does not, so the stage is never a broken image.
    var stagePath: String? {
        guard case let .source(source)? = state.content else { return nil }
        if source.hasOriginalPath, !source.originalPath.isEmpty { return source.originalPath }
        if source.hasThumbnailPath, !source.thumbnailPath.isEmpty { return source.thumbnailPath }
        return nil
    }

    /// A save that did not land, else the reason one cannot fire, else nil.
    var refusalLine: String? {
        if state.hasSaveFailure, !state.saveFailure.sentence.isEmpty {
            return [state.saveFailure.sentence, state.saveFailure.remedy]
                .filter { !$0.isEmpty }
                .joined(separator: " ")
        }
        return state.saveRefusal.isEmpty ? nil : state.saveRefusal
    }

    // MARK: - Events

    var rotateEvent: Data { encoded { $0.rotate = .init() } }
    var straightenEvent: Data { encoded { $0.straighten = .init() } }
    var flipEvent: Data { encoded { $0.flip = .init() } }
    var resetEvent: Data { encoded { $0.reset = .init() } }
    var cancelEvent: Data { encoded { $0.cancel = .init() } }
    var saveEvent: Data { encoded { $0.save = .init() } }

    func ratioEvent(_ ratio: Centraid_Screen_V1_PhotoEditPlan.Ratio, frameRatio: Double) -> Data {
        encoded {
            $0.ratio = .with {
                $0.ratio = ratio
                $0.frameRatio = frameRatio
            }
        }
    }

    func movedEvent(_ dx: Double, _ dy: Double) -> Data {
        encoded {
            $0.cropMoved = .with {
                $0.dx = dx
                $0.dy = dy
            }
        }
    }

    func scaledEvent(_ factor: Double) -> Data {
        encoded { $0.cropScaled = .with { $0.factor = factor } }
    }

    func discardEvent(_ discard: Bool) -> Data {
        encoded { $0.discard = .with { $0.discard = discard } }
    }

    /// A serialisation that throws yields EMPTY bytes, which the reducer's
    /// `else` answers with `Step(state)` — a tap that does nothing rather than a
    /// shell that dies on one.
    private func encoded(_ build: (inout Centraid_Screen_V1_PhotoEditorEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_PhotoEditorEvent()
        build(&event)
        return (try? event.serializedData()) ?? Data()
    }

    // MARK: - The words
    //
    // `PhotoEditorMachine`'s, mirrored: this view holds SwiftProtobuf's types
    // and not the shared module's, so the constants are restated rather than
    // called — the lightbox's share rows are the same arrangement.

    static let title = "Crop and rotate"
    static let cancelWord = "Cancel"
    static let saveWord = "Save as a new photograph"
    static let explanation =
        "Saving writes a new photograph with the original's date and place; the original is not touched."
    static let discardQuestion = "Discard this edit?"
    static let discardWord = "Discard"
    static let keepEditingWord = "Keep editing"
    static let ratios: [Centraid_Screen_V1_PhotoEditPlan.Ratio] = [.original, .square, .threeTwo]

    /// SPACING IS LOAD-BEARING: `3 : 2` renders in the numeric register.
    static func ratioName(_ ratio: Centraid_Screen_V1_PhotoEditPlan.Ratio) -> String {
        switch ratio {
        case .square: return "Square"
        case .threeTwo: return "3 : 2"
        default: return "Original"
        }
    }

    /// "from a photograph taken 30 July 2026" — v0's `editorMeta`, and "from a
    /// photograph" when the row records no time. The day is the one the shutter
    /// fired on, in the capture's own zone, so it names the day the Library and
    /// the viewer file the photograph under; no offset is UTC, as there.
    static func meta(_ capturedAt: String, offsetMinutes: Int) -> String {
        guard let when = instant(capturedAt) else { return "from a photograph" }
        var style = Date.FormatStyle.dateTime.day().month(.wide).year()
        style.timeZone = TimeZone(secondsFromGMT: offsetMinutes * 60) ?? .gmt
        return "from a photograph taken \(when.formatted(style))"
    }

    /// The vault writes `%Y-%m-%dT%H:%M:%fZ`; fractional seconds first, for the
    /// lightbox's reason.
    private static func instant(_ text: String) -> Date? {
        guard !text.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = fractional.date(from: text) { return parsed }
        let whole = ISO8601DateFormatter()
        whole.formatOptions = [.withInternetDateTime]
        return whole.date(from: text)
    }
}

// MARK: - The lightbox's Edit button

/// WHERE "EDIT" GOES. Set by the composition root around the lightbox; absent
/// (a preview, a fixture) means the button draws refused rather than live over
/// nothing.
private struct OpenPhotoEditorKey: EnvironmentKey {
    static let defaultValue: ((String, [String]) -> Void)? = nil
}

extension EnvironmentValues {
    var openPhotoEditor: ((String, [String]) -> Void)? {
        get { self[OpenPhotoEditorKey.self] }
        set { self[OpenPhotoEditorKey.self] = newValue }
    }
}

/// THE EDIT BUTTON ON THE LIGHTBOX'S BAR (#1029, photos port).
///
/// It lives HERE, beside the screen it opens, so the lightbox carries one line
/// for it and no knowledge of the editor. Live, or refused with the sentence
/// `PhotoEditorMachine.editRefusal` gives — mirrored by hand below — for a
/// video, or an original this phone does not hold yet; the lightbox's own
/// status line already carries "Load the original" for the second.
struct PhotoEditButton: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openPhotoEditor) private var open
    let detail: Centraid_Screen_V1_PhotoDetail
    let neighbours: [String]

    var body: some View {
        let refusal = Self.refusal(detail)
        let enabled = refusal == nil && open != nil
        Button {
            guard enabled else { return }
            open?(detail.assetID, neighbours)
        } label: {
            CentraidIconView(
                iconKey: "Sliders",
                // THE STAGE'S OWN SOFT INK for a refused target, as the bar's
                // other verbs draw it.
                tint: Theme.color(enabled ? "onStage" : "onStageSoft", scheme),
                size: 24
            )
        }
        .disabled(!enabled)
        .accessibilityLabel("Edit")
        .accessibilityHint(refusal ?? "")
        .accessibilityIdentifier("photos.lightbox.edit")
    }

    /// `PhotoEditorMachine.editRefusal`, mirrored.
    static func refusal(_ detail: Centraid_Screen_V1_PhotoDetail) -> String? {
        if detail.assetID.isEmpty { return "This photograph is not in a vault yet." }
        guard detail.kind == .photo || detail.kind == .scan else {
            return "Crop and rotate work on photographs, not on this kind of media"
        }
        switch detail.held {
        case .original: return nil
        case .withheldByRule: return "Load the original first."
        case .fetching: return "The original is still loading."
        default: return "The original is not on this phone yet."
        }
    }
}
