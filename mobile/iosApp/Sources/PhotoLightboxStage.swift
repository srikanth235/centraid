import AVFoundation
import ImageIO
import SwiftUI
import UIKit

/// THE STAGE — the photograph, and the three gestures a member reaches it by
/// (#1029 photos port; v0's `MediaPage.tsx` and `lightbox-gestures.ts`). The
/// Compose twin is `PhotoLightboxStage.kt`.
///
/// - **A horizontal swipe pages** to the shelf's next or previous photograph.
///   The neighbours slide in as their filmstrip frames, so the photograph a
///   member is swiping TO is on screen before its read lands. The pager
///   chevrons stay in the chrome: nothing here is reachable by gesture alone.
/// - **A pinch, or a double tap, zooms**, from fit to 2.5× and up to 5×, and a
///   one-finger drag pans a zoomed photograph. A zoomed photograph does not
///   page — the drag that would have paged is the drag that pans it.
/// - **A swipe down closes**, the `StageRoom`'s own way out (DESIGN.md); the
///   close control in the chrome is the same act.
///
/// One bare tap toggles the chrome, a long press plays a Live Photo's movie.
/// Every settle runs on the one state-change curve and cuts under reduced
/// motion.
struct PhotoLightboxStage: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let state: PhotoLightboxStateView
    let player: LightboxPlayer?
    let live: LightboxPlayer?
    let send: (Data) -> Void
    let onClose: () -> Void

    /// THE PHOTOGRAPH THE STAGE IS DRAWING, which leads the state by one frame
    /// on a swipe: the incoming frame is already under the member's finger
    /// when `Moved` is sent.
    @State private var shown = ""
    @State private var pageX: CGFloat = 0
    @State private var dismissY: CGFloat = 0
    @State private var scale: CGFloat = 1
    @State private var settledScale: CGFloat = 1
    @State private var pan: CGSize = .zero
    @State private var settledPan: CGSize = .zero
    @State private var axis: Axis?

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            let current = shown.isEmpty ? state.assetID : shown
            let neighbours = state.neighbours
            let at = neighbours.firstIndex(of: current)
            let previous = at.flatMap { $0 > 0 ? neighbours[$0 - 1] : nil }
            let next = at.flatMap { $0 + 1 < neighbours.count ? neighbours[$0 + 1] : nil }
            ZStack {
                if let previous {
                    frame(previous).offset(x: -size.width + pageX, y: dismissY)
                }
                if let next {
                    frame(next).offset(x: size.width + pageX, y: dismissY)
                }
                page(current)
                    .scaleEffect(scale)
                    .offset(x: pageX + pan.width, y: dismissY + pan.height)
                    // A SLIDESHOW DISSOLVES on the state-change curve and cuts
                    // under reduced motion; a hand-driven page does not.
                    .id(current)
                    .transition(state.slideshow && !reduceMotion ? .opacity : .identity)
            }
            .frame(width: size.width, height: size.height)
            .clipped()
            .contentShape(Rectangle())
            .gesture(drag(size: size, previous: previous, next: next))
            .simultaneousGesture(magnify(size: size))
            // DOUBLE BEFORE SINGLE, so the single tap waits for the double to
            // fail: a chrome that flashed away on every zoom is the bug the
            // order prevents.
            .onTapGesture(count: 2, coordinateSpace: .local) { location in
                doubleTap(at: location, size: size)
            }
            .onTapGesture { send(state.chromeEvent(!state.chromeVisible)) }
            .onLongPressGesture(minimumDuration: 0.4) { live?.playFromStart() }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(state.stageLabel)
            .accessibilityIdentifier("photos.lightbox.stage.\(state.assetID)")
        }
        .onChange(of: state.assetID) { _, identifier in
            resetZoom()
            if state.slideshow && !reduceMotion {
                withAnimation(curve) { shown = identifier }
            } else {
                shown = identifier
            }
        }
    }

    // MARK: - What a page draws

    /// A neighbour, as its strip frame.
    @ViewBuilder
    private func frame(_ identifier: String) -> some View {
        if let path = state.framePath(identifier) {
            StageImage(path: path, maxPixel: 1024)
        } else {
            Color.clear
        }
    }

    /// WHAT ONE PAGE OF THE STAGE DRAWS, from the most to the least it can:
    /// the located original when the byte door said this device holds it and
    /// it may be drawn, over the thumbnail, which is on screen from the first
    /// frame — and before the photograph's own read lands, its strip frame. A
    /// video with its file here plays; one without draws its still.
    @ViewBuilder
    private func page(_ identifier: String) -> some View {
        ZStack {
            if let thumbnail = state.thumbnailPath(for: identifier) {
                StageImage(path: thumbnail, maxPixel: 1024)
            }
            if identifier == state.assetID {
                if state.isVideo, let player {
                    PlayerSurface(player: player.player)
                } else if let original = state.drawableOriginal {
                    StageImage(path: original, maxPixel: 4096)
                }
                if let live {
                    LiveOverlay(live: live)
                }
            }
        }
    }

    // MARK: - Gestures

    private var curve: Animation {
        .timingCurve(0.3, 0, 0.4, 1, duration: CentraidGeometry.durationOne / 1000)
    }

    private func settle(_ change: @escaping () -> Void, then: (() -> Void)? = nil) {
        if reduceMotion {
            change()
            then?()
        } else {
            withAnimation(curve, change, completion: { then?() })
        }
    }

    private var zoomable: Bool { !state.isVideo && !state.slideshow }
    private var zoomed: Bool { scale > zoomFit + 0.001 }

    private func drag(size: CGSize, previous: String?, next: String?) -> some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                if zoomed {
                    pan = clamped(
                        CGSize(
                            width: settledPan.width + value.translation.width,
                            height: settledPan.height + value.translation.height
                        ),
                        size: size
                    )
                    return
                }
                if state.slideshow { return }
                if axis == nil {
                    axis = abs(value.translation.width) > abs(value.translation.height)
                        ? .horizontal : .vertical
                }
                switch axis {
                case .horizontal:
                    let dx = value.translation.width
                    // A SHELF'S EDGE RESISTS rather than sliding into nothing.
                    let edge = (dx > 0 && previous == nil) || (dx < 0 && next == nil)
                    pageX = edge ? dx / 3 : dx
                case .vertical:
                    dismissY = max(0, value.translation.height)
                case nil:
                    break
                }
            }
            .onEnded { value in
                defer { axis = nil }
                if zoomed {
                    settledPan = pan
                    return
                }
                switch axis {
                case .horizontal:
                    let threshold = size.width * pageThreshold
                    let target: String? = pageX < -threshold ? next : (pageX > threshold ? previous : nil)
                    guard let target else {
                        settle { pageX = 0 }
                        return
                    }
                    let end = target == next ? -size.width : size.width
                    settle({ pageX = end }, then: {
                        shown = target
                        pageX = 0
                        send(state.movedEvent(target))
                    })
                case .vertical:
                    if dismissY > dismissDistance || value.predictedEndTranslation.height > dismissDistance * 2 {
                        onClose()
                    } else {
                        settle { dismissY = 0 }
                    }
                case nil:
                    break
                }
            }
    }

    private func magnify(size: CGSize) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                guard zoomable else { return }
                scale = min(zoomMax, max(zoomFit, settledScale * value.magnification))
                pan = clamped(settledPan, size: size)
            }
            .onEnded { _ in
                guard zoomable else { return }
                if scale <= zoomFit + 0.01 {
                    settle { resetZoom() }
                } else {
                    settledScale = scale
                    settledPan = pan
                }
            }
    }

    /// FIT AND 2.5×, and THE POINT UNDER THE FINGER STAYS UNDER IT.
    private func doubleTap(at location: CGPoint, size: CGSize) {
        guard zoomable else { return }
        if zoomed {
            settle { resetZoom() }
            return
        }
        let target = zoomRung
        let offset = CGSize(
            width: (size.width / 2 - location.x) * (target - 1),
            height: (size.height / 2 - location.y) * (target - 1)
        )
        settle {
            scale = target
            settledScale = target
            pan = clamped(offset, size: size)
            settledPan = pan
        }
    }

    private func resetZoom() {
        scale = zoomFit
        settledScale = zoomFit
        pan = .zero
        settledPan = .zero
    }

    private func clamped(_ offset: CGSize, size: CGSize) -> CGSize {
        let limitX = max(0, (size.width * scale - size.width) / 2)
        let limitY = max(0, (size.height * scale - size.height) / 2)
        return CGSize(
            width: min(limitX, max(-limitX, offset.width)),
            height: min(limitY, max(-limitY, offset.height))
        )
    }
}

/// v0's `ZOOM_FIT`, `ZOOM_RUNG` and `ZOOM_MAX`.
private let zoomFit: CGFloat = 1
private let zoomRung: CGFloat = 2.5
private let zoomMax: CGFloat = 5
/// A fifth of the stage is a page turn; less springs back.
private let pageThreshold: CGFloat = 0.2
/// How far down a swipe has to travel before it is a close.
private let dismissDistance: CGFloat = 120

// MARK: - One still

/// ONE STILL, FIT TO THE STAGE, decoded off the main thread, upright, and no
/// larger than [maxPixel] on its longest edge — a 48-megapixel photograph
/// decoded whole is memory a phone does not have to spend, and a zoomed screen
/// needs a fraction of it.
struct StageImage: View {
    let path: String
    let maxPixel: Int

    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                Color.clear
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .task(id: "\(path)|\(maxPixel)") {
            image = StageImageCache.cached(path, maxPixel)
            if image != nil { return }
            let loaded = await Task.detached(priority: .userInitiated) {
                StageImageCache.decode(path, maxPixel)
            }.value
            image = loaded
        }
    }
}

/// The decoded stills, by path and size. Small: a lightbox holds three pages
/// and a strip, and anything older is cheap to decode again.
enum StageImageCache {
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 48
        return cache
    }()

    static func cached(_ path: String, _ maxPixel: Int) -> UIImage? {
        cache.object(forKey: "\(path)|\(maxPixel)" as NSString)
    }

    /// `kCGImageSourceCreateThumbnailWithTransform` is what makes it upright:
    /// the EXIF orientation is applied, and a sideways photograph is not.
    static func decode(_ path: String, _ maxPixel: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil)
        else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let decoded = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { return nil }
        let image = UIImage(cgImage: decoded)
        cache.setObject(image, forKey: "\(path)|\(maxPixel)" as NSString)
        return image
    }
}

// MARK: - Players

/// A PLAYER AND WHAT THE CHROME READS OFF IT.
///
/// AVPlayer is the decoder and the clock; the transport is this screen's own
/// controls, so its time is observed into published state rather than drawn by
/// AVKit's controller. A blob in the store has no extension, so the asset is
/// told what it is by the media type the byte door answered.
@MainActor
final class LightboxPlayer: ObservableObject {
    let player: AVPlayer
    private let once: Bool
    private var observer: Any?
    private var ended: NSObjectProtocol?

    @Published var playing = false
    @Published var position: Double = 0
    @Published var duration: Double = 0
    /// A Live Photo's movie shows only while it plays, then gives the still back.
    @Published var showing = false

    init(path: String, mediaType: String, once: Bool) {
        var options: [String: Any] = [:]
        if !mediaType.isEmpty { options[AVURLAssetOverrideMIMETypeKey] = mediaType }
        let asset = AVURLAsset(url: URL(fileURLWithPath: path), options: options)
        player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
        self.once = once
        observer = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.2, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.position = time.seconds.isFinite ? time.seconds : 0
                let length = self.player.currentItem?.duration.seconds ?? 0
                self.duration = length.isFinite ? length : 0
                self.playing = self.player.timeControlStatus == .playing
            }
        }
        ended = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: player.currentItem,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.playing = false
                if self.once { self.showing = false }
            }
        }
    }

    deinit {
        if let observer { player.removeTimeObserver(observer) }
        if let ended { NotificationCenter.default.removeObserver(ended) }
        player.pause()
    }

    func toggle() {
        if player.timeControlStatus == .playing {
            player.pause()
        } else {
            if duration > 0, position >= duration - 0.05 { player.seek(to: .zero) }
            player.play()
        }
        playing.toggle()
    }

    func seek(to fraction: Double) {
        guard duration > 0 else { return }
        let seconds = duration * min(1, max(0, fraction))
        position = seconds
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    func playFromStart() {
        player.seek(to: .zero)
        player.play()
        showing = true
    }

    func pause() { player.pause() }
}

/// A LIVE PHOTO'S MOVIE, over its still, only while it plays.
private struct LiveOverlay: View {
    @ObservedObject var live: LightboxPlayer

    var body: some View {
        if live.showing { PlayerSurface(player: live.player) }
    }
}

/// THE TWO PLAYERS A LIGHTBOX CAN HOLD — a video's, and a Live Photo's movie
/// — made when their files are located and let go when the photograph moves
/// on. A player left running behind a closed lightbox is a sound with no
/// screen, so a replaced one is paused as it goes.
@MainActor
final class LightboxMedia: ObservableObject {
    @Published private(set) var video: LightboxPlayer?
    @Published private(set) var live: LightboxPlayer?
    private var videoKey = ""
    private var liveKey = ""

    func update(videoPath: String?, mediaType: String, livePath: String?) {
        let nextVideo = videoPath ?? ""
        if nextVideo != videoKey {
            video?.pause()
            videoKey = nextVideo
            video = videoPath.map { LightboxPlayer(path: $0, mediaType: mediaType, once: false) }
        }
        let nextLive = livePath ?? ""
        if nextLive != liveKey {
            live?.pause()
            liveKey = nextLive
            live = livePath.map { LightboxPlayer(path: $0, mediaType: "", once: true) }
        }
    }
}

/// The player's picture, fit to the stage.
struct PlayerSurface: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> PlayerLayerView {
        let view = PlayerLayerView()
        view.isUserInteractionEnabled = false
        view.playerLayer.videoGravity = .resizeAspect
        view.playerLayer.player = player
        return view
    }

    func updateUIView(_ view: PlayerLayerView, context: Context) {
        view.playerLayer.player = player
    }

    final class PlayerLayerView: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}

/// THE TRANSPORT — play, pause and the scrub strip (v0's `Transport`).
///
/// Determinate, always: a position over a length, never a spinner (DESIGN.md
/// §5). The strip is a track the member drags or taps to seek; the time beside
/// it is the clock the strip is drawing.
struct LightboxTransport: View {
    @Environment(\.colorScheme) private var scheme
    @ObservedObject var player: LightboxPlayer

    var body: some View {
        HStack(spacing: 8) {
            Button { player.toggle() } label: {
                CentraidIconView(
                    iconKey: player.playing ? "Pause" : "Play",
                    tint: Theme.color("onStage", scheme),
                    size: 20
                )
                .frame(width: 44, height: 44)
            }
            .accessibilityLabel(player.playing ? "Pause" : "Play")
            GeometryReader { geometry in
                let fraction = player.duration > 0 ? player.position / player.duration : 0
                ZStack(alignment: .leading) {
                    Rectangle()
                        .fill(Theme.color("stageLine", scheme))
                        .frame(height: 2)
                    Rectangle()
                        .fill(Theme.color("onStage", scheme))
                        .frame(width: geometry.size.width * min(1, max(0, fraction)), height: 2)
                }
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0).onChanged { value in
                        player.seek(to: value.location.x / max(1, geometry.size.width))
                    }
                )
            }
            .frame(height: 28)
            .accessibilityElement()
            .accessibilityLabel("Position")
            .accessibilityValue("\(mediaClock(player.position)) of \(mediaClock(player.duration))")
            .accessibilityAdjustableAction { direction in
                guard player.duration > 0 else { return }
                let step = 5 / player.duration
                let now = player.position / player.duration
                player.seek(to: direction == .increment ? now + step : now - step)
            }
            Text("\(mediaClock(player.position)) / \(mediaClock(player.duration))")
                .centraidType("mono")
                .foregroundStyle(Theme.color("onStageSoft", scheme))
        }
    }
}

/// `1:01:40`, with an hours arm — the facts panel's clock, in seconds.
func mediaClock(_ seconds: Double) -> String {
    let total = Int(seconds.isFinite ? max(0, seconds) : 0)
    let hours = total / 3600
    let minutes = (total % 3600) / 60
    let rest = total % 60
    return hours > 0
        ? String(format: "%d:%02d:%02d", hours, minutes, rest)
        : String(format: "%d:%02d", minutes, rest)
}

// MARK: - The filmstrip

/// THE FILMSTRIP — v0's `PhotoFilmstrip`, 58 high: the current frame at 58
/// with a 2-wide outline, its neighbours at 40, 2 apart. The swipe and the
/// strip are one control from two directions: the swipe is fast, the strip
/// says where a member is and lets them jump.
struct LightboxFilmstrip: View {
    @Environment(\.colorScheme) private var scheme
    let state: PhotoLightboxStateView
    let send: (Data) -> Void

    var body: some View {
        let window = state.filmWindow
        if window.count > 1 {
            ScrollViewReader { reader in
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 2) {
                        ForEach(Array(window.enumerated()), id: \.element) { index, identifier in
                            frame(identifier, number: state.filmOffset + index + 1)
                                .id(identifier)
                        }
                    }
                }
                .frame(height: 58)
                // PAGING MOVES THE STRIP TOO, or the two controls disagree
                // about where the member is.
                .onAppear { reader.scrollTo(state.assetID, anchor: .center) }
                .onChange(of: state.assetID) { _, identifier in
                    reader.scrollTo(identifier, anchor: .center)
                }
            }
            .accessibilityLabel("Filmstrip")
        }
    }

    @ViewBuilder
    private func frame(_ identifier: String, number: Int) -> some View {
        let here = identifier == state.assetID
        let side: CGFloat = here ? 58 : 40
        Button {
            if !here { send(state.movedEvent(identifier)) }
        } label: {
            ZStack {
                Theme.color("skel", scheme)
                if let path = state.framePath(identifier) {
                    StageFrame(path: path)
                }
            }
            .frame(width: side, height: side)
            .clipped()
            .overlay {
                if here {
                    Rectangle().strokeBorder(Theme.color("onStage", scheme), lineWidth: 2)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Show photograph \(number) of \(state.neighbours.count)")
        .accessibilityAddTraits(here ? .isSelected : [])
    }
}

/// A strip frame: a thumbnail CROPPED to its square, as a grid cell is.
private struct StageFrame: View {
    let path: String
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Color.clear
            }
        }
        .task(id: path) {
            image = StageImageCache.cached(path, 160)
            if image != nil { return }
            image = await Task.detached(priority: .utility) { StageImageCache.decode(path, 160) }.value
        }
    }
}

/// A Live Photo's own control: the word, and the movie it plays.
struct LiveChip: View {
    @Environment(\.colorScheme) private var scheme
    let live: LightboxPlayer

    var body: some View {
        Button { live.playFromStart() } label: {
            HStack(spacing: 4) {
                CentraidIconView(iconKey: "Play", tint: Theme.color("onStage", scheme), size: 14)
                Text("Live").centraidType("small").foregroundStyle(Theme.color("onStage", scheme))
            }
            .padding(.horizontal, 10)
            .frame(height: 28)
            .background(Theme.color("stageSunken", scheme), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Play Live Photo")
    }
}
