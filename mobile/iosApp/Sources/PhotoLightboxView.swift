import Foundation
import SwiftProtobuf
import SwiftUI

import CentraidShared

/// ONE PHOTOGRAPH, FULL BLEED (#1029, photos port).
///
/// The screen a member spends most of their time in, and the one v0 reasoned
/// about hardest: `viewer-model.ts`, `viewer-toolbar-states.ts` and
/// `viewer-write-refusal.ts` are three files whose whole subject is which verbs
/// are offered and WHY one is withheld. **A toolbar that offers a verb the
/// vault will refuse is worse than one that explains the refusal**, so every
/// control here is either live or visibly refused with a sentence — v0's
/// toolbar rendered all five identically, so four of them looked armed and
/// silently did nothing (#1015 B10).
///
/// ## The four things this view is
///
/// 1. **A STAGE** (`PhotoLightboxStage.swift`). The photograph runs edge to
///    edge under the chrome, which floats on it; a swipe pages, a pinch or a
///    double tap zooms, a swipe down closes. There is no top bar: a
///    full-width strip is a second ground over the photograph.
/// 2. **CHROME THAT IS STATE.** A tap on the stage hides the controls and
///    another brings them back, and `chrome_visible` is reduced rather than
///    animated — a member who has hidden them and rotates the phone must not
///    get them back. A running screen reader pins them open.
/// 3. **A MODE.** The slideshow is this screen with a clock: no filmstrip, no
///    info, and one way out — Leave.
/// 4. **FIVE SHEETS.** Info (everything the vault knows, and the four things a
///    member may change), Share (what leaves the vault, and in what form),
///    More, the place picker, and the shared album choice.
///
/// ## What it draws when the bytes are not here
///
/// The thumbnail, and a line that says where the original is. The ORIGINAL is
/// drawn once the byte door has located it on this device
/// (`PhotoLightboxBridge.locate`) — a truthful state at every step, never a
/// broken image.
struct PhotoLightboxView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

    /// The encoded `PhotoLightboxState` the bridge published.
    ///
    /// Bytes and not an object, for `PhotosBridge`'s reason: one schema, one
    /// fixture, no Objective-C bridging layer between the two shells.
    let data: Data

    /// One encoded `PhotoLightboxEvent`, back to the bridge.
    let send: (Data) -> Void

    /// The screen's players — a video's, and a Live Photo's movie.
    @StateObject private var media = LightboxMedia()

    var body: some View {
        let state = PhotoLightboxStateView(data: data)
        // A SCREEN READER PINS THE CHROME OPEN (v0's `use-screen-reader.ts`):
        // a control reachable only by an unlabelled full-screen tap is not
        // reachable at all under VoiceOver. The slideshow keeps its chrome too
        // — Leave is the only way out of it.
        let chromeVisible = state.chromeVisible || voiceOver || state.slideshow
        ZStack {
            // THE STAGE IS THE DARKEST SURFACE AND IT IS NOT THE PAGE. A
            // photograph on paper reads as a document; the viewer's ground is
            // its own role so the two cannot drift apart.
            Theme.color("stage", scheme).ignoresSafeArea()
            switch state.content {
            case .loading:
                // BEFORE THE READ LANDS THE STAGE STILL DRAWS what it has —
                // the strip frame of the photograph a member swiped to — and a
                // ring only over a stage with nothing at all.
                stage(state).ignoresSafeArea()
                if state.framePath(state.assetID) == nil {
                    Text(KitWords.shared.OPENING)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("onStageSoft", scheme))
                }
            case let .denied(denied):
                DeniedGate(denied)
            case let .failure(sentence, remedy):
                ScreenFailureView(sentence: sentence, remedy: remedy)
                    .padding(CentraidGeometry.pageMargin)
            case let .data(detail):
                stage(state).ignoresSafeArea()
                if state.drawablePath == nil {
                    // NEVER A BROKEN IMAGE. Each of these is a truthful state,
                    // and the sentence says which one.
                    Text(state.stageLabel)
                        .centraidType("body")
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Theme.color("onStage", scheme))
                        .padding(CentraidGeometry.pageMargin)
                        .allowsHitTesting(false)
                }
                if chromeVisible { chrome(state, detail) }
            }
        }
        // THE STAGE ROOM TAKES NO HEADER (DESIGN.md): its way out is the close
        // chip and the swipe down, both the same act.
        .toolbar(.hidden, for: .navigationBar)
        .sheet(item: sheetBinding(state)) { item in
            sheet(item.kind, state)
        }
        .onChange(of: state.mediaKey, initial: true) { _, _ in
            media.update(
                videoPath: state.videoPath,
                mediaType: state.originalMediaType,
                livePath: state.livePath
            )
        }
        // THE SLIDESHOW'S CLOCK. The shell owns the clock and the reducer owns
        // where it goes; keyed on the photograph, so a manual move restarts
        // the count rather than cutting the next photograph short.
        .task(id: "\(state.slideshow)|\(state.assetID)") {
            guard state.slideshow else { return }
            media.video?.pause()
            try? await Task.sleep(nanoseconds: PhotoLightboxStateView.slideshowNanoseconds)
            guard !Task.isCancelled else { return }
            send(PhotoLightboxStateView.slideshowAdvancedEvent)
        }
    }

    private func stage(_ state: PhotoLightboxStateView) -> some View {
        PhotoLightboxStage(
            state: state,
            player: media.video,
            live: media.live,
            send: send,
            onClose: { dismiss() }
        )
    }

    // MARK: - The chrome

    @ViewBuilder
    private func chrome(
        _ state: PhotoLightboxStateView,
        _ detail: Centraid_Screen_V1_PhotoDetail
    ) -> some View {
        VStack(spacing: 0) {
            // THREE FLOATING THINGS ACROSS THE TOP: the way out, the stamp and
            // the menu. The stamp takes the middle because it is the only one
            // that is not a control: `30 July 2026` over `17:42 · Lyme Regis`.
            // WHEN outranks WHAT.
            HStack(alignment: .top) {
                chip(icon: "ChevronLeft", label: PhotosCopy.shared.PHOTOS_CLOSE) { dismiss() }
                    .accessibilityIdentifier("photos.lightbox.close")
                Spacer()
                VStack(spacing: 2) {
                    let title = state.slideshow ? PhotosCopy.shared.PHOTOS_SLIDESHOW : state.stampDate
                    let meta = state.slideshow ? state.slideshowMeta : state.stampLine
                    if !title.isEmpty { Text(title).centraidType("control") }
                    if !meta.isEmpty {
                        Text(meta)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("onStageSoft", scheme))
                    }
                }
                .foregroundStyle(Theme.color("onStage", scheme))
                Spacer()
                if state.slideshow {
                    // THE ONE WAY OUT OF THE SLIDESHOW, named for what it does.
                    Button {
                        send(state.slideshowEvent(false))
                    } label: {
                        Text(PhotosCopy.shared.PHOTOS_SLIDESHOW_LEAVE)
                            .centraidType("control")
                            .foregroundStyle(Theme.color("onStage", scheme))
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("photos.lightbox.leaveSlideshow")
                } else {
                    chip(icon: "more", label: PhotosCopy.shared.PHOTOS_MORE) { send(state.sheetEvent(.more)) }
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)

            Spacer()

            if !state.slideshow, let live = media.live {
                LiveChip(live: live).padding(.bottom, 8)
            }

            statusLine(state)

            // A WRITE THAT WAS REFUSED, AS A LINE OVER THE CHROME — over it
            // and never instead of the photograph: `write_failure` is its own
            // slot precisely so a denied favourite cannot take the picture off
            // the screen.
            if let refused = state.writeFailure {
                Text(refused)
                    .centraidType("small")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Theme.color("onStage", scheme))
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.bottom, 8)
                    .accessibilityIdentifier("photos.lightbox.writeFailure")
            }

            if !state.slideshow {
                if let video = media.video {
                    LightboxTransport(player: video)
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                }
                // THE FILMSTRIP SITS DIRECTLY ABOVE THE PAGER AND THE ROW, and
                // goes away with the rest of the chrome.
                LightboxFilmstrip(state: state, send: send)
                    .padding(.bottom, 4)
                pager(state)
                toolbar(state, detail)
            }
        }
        .padding(.vertical, 8)
    }

    /// THE ONE STATUS LINE, drawn only when it has something to say. A receipt
    /// beats a byte status, because it is about something the member just did.
    @ViewBuilder
    private func statusLine(_ state: PhotoLightboxStateView) -> some View {
        let line = state.slideshow
            ? PhotoLightboxStateView.slideshowLine
            : (state.notice.isEmpty ? state.statusLine(playing: media.video != nil) : state.notice)
        if !line.isEmpty {
            HStack(spacing: 8) {
                // HOW FAR IT HAS GOT, WHEN ANYONE CAN SAY (`fetch_percent`).
                // Zero is an honest "not known", so it draws a turning ring
                // with no number.
                if !state.slideshow, state.isFetching {
                    if let fraction = state.fetchFraction {
                        KitProgressBar(fraction: fraction, onStage: true)
                            .frame(width: 44)
                    } else {
                        StageSpinner()
                    }
                }
                Text(line)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("onStageSoft", scheme))
                    .accessibilityIdentifier("photos.lightbox.status")
                if !state.slideshow, state.notice.isEmpty, state.offersFetch {
                    Button {
                        send(state.fetchEvent)
                    } label: {
                        Text(PhotosCopy.shared.PHOTOS_LOAD_ORIGINAL)
                            .centraidType("control")
                            .foregroundStyle(Theme.color("onStage", scheme))
                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("photos.lightbox.fetch")
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.bottom, 8)
        }
    }

    /// THE POINTER EQUIVALENT FOR SWIPE (§15). Nothing in this shell is
    /// reachable by gesture alone, and a phone has no arrow keys to offer
    /// instead — so previous and next are controls on the stage. One with
    /// nowhere to go takes the stage's soft ink on its own glyph, never a
    /// faded container.
    @ViewBuilder
    private func pager(_ state: PhotoLightboxStateView) -> some View {
        if state.neighbours.count > 1 {
            HStack {
                pagerButton(icon: "ChevronLeft", label: PhotosCopy.shared.PHOTOS_PREVIOUS, target: state.previous, state)
                Spacer()
                pagerButton(icon: "ChevronRight", label: PhotosCopy.shared.PHOTOS_NEXT, target: state.next, state)
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
        }
    }

    private func pagerButton(
        icon: String,
        label: String,
        target: String?,
        _ state: PhotoLightboxStateView
    ) -> some View {
        Button {
            if let target { send(state.movedEvent(target)) }
        } label: {
            CentraidIconView(
                iconKey: icon,
                tint: Theme.color(target == nil ? "onStageSoft" : "onStage", scheme),
                size: 20
            )
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(target == nil)
        .accessibilityLabel(label)
    }

    /// THE BOTTOM ROW. Every verb is live or visibly refused, and the refusal
    /// is a VISIBLE sentence and not only an accessibility hint — a member who
    /// can see the screen is owed the reason as much as one who cannot.
    @ViewBuilder
    private func toolbar(
        _ state: PhotoLightboxStateView,
        _ detail: Centraid_Screen_V1_PhotoDetail
    ) -> some View {
        VStack(spacing: 4) {
            // 44 TARGETS, so the six sit 8 apart: 6 x 44 + 5 x 20 would not fit.
            HStack(spacing: 8) {
                verb(.share, state)
                verb(.favorite, state, on: detail.favorite)
                verb(.info, state)
                // EDIT, in v0's place after Info. Its gate and its route live
                // with the editor (`PhotoEditorView.swift`), not in this bar.
                PhotoEditButton(detail: detail, refusal: state.editRefusal, neighbours: state.neighbours)
                verb(.archive, state, on: detail.archived)
                verb(.trash, state)
            }
            if let refusal = state.refusal {
                Text(refusal)
                    .centraidType("small")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Theme.color("onStageSoft", scheme))
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
    }

    @ViewBuilder
    private func verb(
        _ verb: PhotoLightboxVerb,
        _ state: PhotoLightboxStateView,
        on: Bool = false
    ) -> some View {
        let enabled = state.isEnabled(verb)
        Button {
            guard enabled else { return }
            send(state.event(for: verb, on: on))
        } label: {
            CentraidIconView(
                iconKey: verb.iconKey,
                // A REFUSED TARGET IS GREYED WITH THE STAGE'S OWN SOFT INK,
                // never the page's disabled ink: `textDisabled` is mixed
                // against paper and on the stage reads as an ABSENT control
                // rather than a refused one.
                tint: Theme.color(enabled ? "onStage" : "onStageSoft", scheme),
                size: 24
            )
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(verb.label(on: on))
        .accessibilityHint(enabled ? "" : (state.refusal ?? ""))
        .accessibilityIdentifier("photos.lightbox.\(verb.identifier)")
    }

    /// One round plate around one control. 44pt EXACTLY and deliberately not
    /// the bar's larger target: a big circle floating on a photograph is a
    /// plate, not a chip.
    private func chip(icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            CentraidIconView(iconKey: icon, tint: Theme.color("onStage", scheme), size: 20)
                .frame(width: 44, height: 44)
                .background(Theme.color("stageSunken", scheme), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    // MARK: - The sheets

    /// ONE `.sheet(item:)` FOR ALL FIVE, and that is the point: moving from
    /// Info to the place picker, or from More to the album choice, is one
    /// item replacing another, which SwiftUI dismisses and presents in order.
    /// Five `isPresented` bindings flipping in one update would ask it to
    /// present while it is still dismissing, and it would present nothing.
    ///
    /// A swipe-to-dismiss reaches the reducer too, or the state would still
    /// say `INFO` with nothing on screen and the next tap on Info would be a
    /// no-op — the shape of bug that makes a control feel broken every second
    /// press.
    private func sheetBinding(_ state: PhotoLightboxStateView) -> Binding<LightboxSheetItem?> {
        Binding(
            get: { state.presentedSheet },
            set: { item in
                guard item == nil else { return }
                if state.albumChoiceOpen {
                    send(PhotoLightboxStateView.albumChoiceDismissedEvent)
                } else if state.presentedSheet != nil {
                    send(state.closeSheetEvent)
                }
            }
        )
    }

    @ViewBuilder
    private func sheet(_ kind: LightboxSheetItem.Kind, _ state: PhotoLightboxStateView) -> some View {
        switch kind {
        case .info:
            PhotoInfoSheetView(state: state, send: send)
                .presentationDetents([.fraction(0.64), .large])
        case .share:
            shareSheet(state)
        case .more:
            moreSheet(state)
        case .place:
            placeSheet(state)
        case .album:
            AlbumChoiceSheet(
                choices: state.albumChoices,
                onChoose: { send(PhotoLightboxStateView.albumChosenEvent($0)) },
                onNewAlbum: { send(PhotoLightboxStateView.albumCreatedEvent($0)) },
                onCancel: { send(PhotoLightboxStateView.albumChoiceDismissedEvent) }
            )
        }
    }

    /// WHAT LEAVES THE VAULT, AND IN WHAT FORM (#816).
    ///
    /// Asked EVERY time, `none` included: a share is a decision about bytes and
    /// never a direct hand-off, and a default that is never surfaced is a
    /// decision the member did not make.
    ///
    /// The rows and their words are `PhotoLightboxBridge.kt`'s
    /// `sharePlaceOptions`, called across the Kotlin boundary: the tested
    /// statement of them is the only one.
    private func shareSheet(_ state: PhotoLightboxStateView) -> some View {
        SheetRoom(title: PhotosCopy.shared.PHOTOS_SEND_PLACE_TITLE) {
            ForEach(state.shareChoices, id: \.precision) { choice in
                Button {
                    send(state.closeSheetEvent)
                    guard let detail = state.detail else { return }
                    PhotoHandOff.send(detail, precision: choice.precision) { outcome in
                        if let outcome { send(PhotoLightboxStateView.handOffEvent(outcome)) }
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(choice.label)
                            .centraidType("control")
                            .foregroundStyle(Theme.color("text", scheme))
                        Text(choice.detail)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(KitRowPress())
                .accessibilityIdentifier("photos.lightbox.share.\(choice.precision.rawValue)")
            }
        }
        .presentationDetents([.medium])
    }

    /// The `···` menu, as a sheet — v0's `viewer-menu.ts`, in iOS' own group
    /// order.
    ///
    /// **THE OMISSIONS ARE CHECKED CLAIMS, not oversights.** Copy, Duplicate
    /// and Adjust Date & Time are not here because there is no write behind
    /// any of them. Make key photo is here only inside an album — a row with
    /// nothing behind it is left out, never shown permanently disabled — and
    /// Slideshow only on a shelf with somewhere to go. Delete is LAST, because
    /// nothing is placed under a destructive row, and the safety is the trash
    /// behind it, never the row being hard to find.
    private func moreSheet(_ state: PhotoLightboxStateView) -> some View {
        OptionSheet(title: PhotosCopy.shared.PHOTOS_MORE) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    moreRow(icon: "Archive", label: state.archiveVerb, refusal: state.refusal) {
                        send(state.closeSheetEvent)
                        send(state.event(for: .archive, on: state.isArchived))
                    }
                    if state.neighbours.count > 1 {
                        moreRow(icon: "Play", label: PhotosCopy.shared.PHOTOS_SLIDESHOW, refusal: nil) {
                            send(state.slideshowEvent(true))
                        }
                    }
                    moreRow(icon: "FolderPlus", label: PhotosCopy.shared.PHOTOS_ADD_TO_ALBUM, refusal: state.refusal) {
                        send(PhotoLightboxStateView.albumChoiceOpenedEvent)
                    }
                    if !state.albumID.isEmpty {
                        moreRow(icon: "Star", label: PhotosCopy.shared.PHOTOS_MAKE_KEY, refusal: state.refusal) {
                            send(state.closeSheetEvent)
                            send(PhotoLightboxStateView.keyPhotoEvent)
                        }
                    }
                    moreRow(icon: "MapPin", label: PhotosCopy.shared.PHOTOS_ADJUST_LOCATION, refusal: state.refusal) {
                        send(state.sheetEvent(.place))
                    }
                    moreRow(icon: "Download", label: PhotosCopy.shared.PHOTOS_DOWNLOAD, refusal: nil) {
                        send(state.closeSheetEvent)
                        guard let detail = state.detail else { return }
                        Task {
                            let outcome = await PhotoHandOff.saveToPhotos(detail)
                            send(PhotoLightboxStateView.handOffEvent(outcome))
                        }
                    }
                    moreRow(icon: "Send", label: PhotosCopy.shared.PHOTOS_SEND_COPY, refusal: nil) {
                        send(state.sheetEvent(.share))
                    }
                    moreRow(icon: "trash", label: PhotosCopy.shared.PHOTOS_DELETE, refusal: state.refusal, destructive: true) {
                        send(state.closeSheetEvent)
                        send(state.event(for: .trash, on: false))
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    /// ONE TEXT SLOT, so a refusal rides after an em dash rather than becoming
    /// a second, shorter phrasing of the same truth. Destructive is `net` ink,
    /// never a fill (DESIGN.md §3).
    private func moreRow(
        icon: String,
        label: String,
        refusal: String?,
        destructive: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        let enabled = refusal == nil
        let ink = Theme.color(!enabled ? "textDisabled" : (destructive ? "net" : "text"), scheme)
        return Button {
            guard enabled else { return }
            action()
        } label: {
            HStack(spacing: 12) {
                CentraidIconView(iconKey: icon, tint: ink, size: 20)
                Text(enabled ? label : "\(label) — \(refusal ?? "")")
                    .centraidType("control")
                    .foregroundStyle(ink)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .disabled(!enabled)
    }

    /// "ADJUST LOCATION" — the places this vault knows, and "No place".
    ///
    /// A place is PICKED here and never typed: `media.set_asset_place` points
    /// at an existing `core_place` row and there is no app-plane command that
    /// mints one, so a free-text field would be a promise the vault cannot
    /// keep. Naming a place is the Places screen's.
    private func placeSheet(_ state: PhotoLightboxStateView) -> some View {
        SheetRoom(title: PhotosCopy.shared.PHOTOS_ADJUST_LOCATION) {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    if let refused = state.writeFailure {
                        Text(refused).centraidType("small").foregroundStyle(Theme.color("net", scheme))
                    }
                    if !state.placeID.isEmpty {
                        placeRow(PhotosCopy.shared.PHOTOS_PLACE_NONE, detail: PhotosCopy.shared.PHOTOS_CLEAR_PLACE_DETAIL) {
                            send(PhotoLightboxStateView.placeChosenEvent(""))
                        }
                    }
                    ForEach(state.placeChoices, id: \.placeID) { place in
                        let here = place.placeID == state.placeID
                        placeRow(place.name, detail: here ? PhotosCopy.shared.PHOTOS_PLACE_HERE : "") {
                            if !here { send(PhotoLightboxStateView.placeChosenEvent(place.placeID)) }
                        }
                    }
                    if state.placeChoices.isEmpty {
                        Text(PhotosCopy.shared.PHOTOS_NO_PLACES)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func placeRow(_ label: String, detail: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .centraidType("control")
                    .foregroundStyle(Theme.color("text", scheme))
                if !detail.isEmpty {
                    Text(detail)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
    }
}

/// The one sheet on screen, as `.sheet(item:)` needs it.
struct LightboxSheetItem: Identifiable, Equatable {
    enum Kind: String {
        case info, share, more, place, album
    }

    let kind: Kind
    var id: String { kind.rawValue }
}

/// THE INFO SHEET — everything the vault knows about this photograph, and the
/// four things a member may change about it: the caption, the labels, the
/// place, and a copy of where it was taken.
///
/// **NO DESTRUCTIVE CONTROL HERE, EVER** (owner ruling, #711 2c): Trash lives
/// on the viewer bar alone, and a second destructive path inside a facts panel
/// is a misfire waiting to happen. Removing a LABEL is not that — it takes a
/// word off a photograph, and the photograph stays.
private struct PhotoInfoSheetView: View {
    @Environment(\.colorScheme) private var scheme
    let state: PhotoLightboxStateView
    let send: (Data) -> Void

    @State private var caption = ""
    @State private var captionFor = ""
    @State private var tag = ""
    @FocusState private var captionFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(state.title).centraidType("title")

                // A REFUSED EDIT IS SAID HERE, where the member made it — the
                // chrome's line is behind this sheet.
                if let refused = state.writeFailure {
                    Text(refused).centraidType("small").foregroundStyle(Theme.color("net", scheme))
                }

                label(PhotosCopy.shared.PHOTOS_LIGHTBOX_CAPTION)
                TextField(PhotosCopy.shared.PHOTOS_CAPTION_PLACEHOLDER, text: $caption)
                    .centraidType("body")
                    .focused($captionFocused)
                    .submitLabel(.done)
                    .onSubmit(commitCaption)
                    .accessibilityLabel(PhotosCopy.shared.PHOTOS_LIGHTBOX_CAPTION)
                    // COMMITTED WHEN THE FIELD IS LEFT, as v0's was on blur:
                    // the typed text stays exactly where it is if the vault
                    // says no.
                    .onChange(of: captionFocused) { _, focused in
                        if !focused { commitCaption() }
                    }

                ForEach(state.facts, id: \.label) { fact in
                    VStack(alignment: .leading, spacing: 2) {
                        label(fact.label)
                        Text(fact.text).centraidType("body")
                    }
                }

                place

                labels

                // WHERE THE BYTES ARE, in a sentence that says what fetching
                // costs — "explicit choice" is only honest if the choice is
                // described before it is offered.
                Text(state.whereabouts)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                if !state.notice.isEmpty {
                    Text(state.notice)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(CentraidGeometry.pageMargin)
        }
        .onAppear(perform: resetCaption)
        .onChange(of: state.assetID) { _, _ in resetCaption() }
        .onDisappear { if captionFocused { commitCaption() } }
        // THE CAMERA, from the original's own header when this device holds
        // it — see `PhotoLightboxReads`' doc for why the vault's row cannot say.
        .task(id: state.originalPath ?? "") {
            guard let path = state.originalPath, state.camera.isEmpty else { return }
            let named = await Task.detached { PhotoHandOff.camera(atPath: path) ?? "" }.value
            // SAID TO THE MACHINE, which owns the facts: it keys the answer by
            // asset and keeps it across a re-read.
            if !named.isEmpty { send(PhotoLightboxStateView.cameraReadEvent(assetIdentifier: state.assetID, camera: named)) }
        }
    }

    private func resetCaption() {
        guard captionFor != state.assetID else { return }
        captionFor = state.assetID
        caption = state.caption
        tag = ""
    }

    private func commitCaption() {
        send(PhotoLightboxStateView.captionEvent(caption))
    }

    /// WHERE, as the vault names it — and the three things a member can do
    /// about it. The coordinate is never printed: "Copy exact location" puts
    /// it on the member's own clipboard because they asked.
    private var place: some View {
        VStack(alignment: .leading, spacing: 4) {
            label(PhotosCopy.shared.PHOTOS_PLACE)
            Text(state.placeLine).centraidType("body")
            HStack(spacing: 16) {
                textAction(state.placeID.isEmpty ? PhotosCopy.shared.PHOTOS_ADD_PLACE : PhotosCopy.shared.PHOTOS_CHANGE) {
                    send(state.sheetEvent(.place))
                }
                if !state.placeID.isEmpty {
                    textAction(PhotosCopy.shared.PHOTOS_REMOVE) { send(PhotoLightboxStateView.placeChosenEvent("")) }
                }
                if state.placeHasCoordinate, let detail = state.detail {
                    textAction(PhotosCopy.shared.PHOTOS_COPY_EXACT_LOCATION) {
                        send(PhotoLightboxStateView.handOffEvent(PhotoHandOff.copyLocation(detail)))
                    }
                }
            }
        }
    }

    /// LABELS, each with its own remove, and a field to add one. Only labels
    /// with a word on them are drawn: a concept id is not a word a member wrote.
    private var labels: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label {
                Text(PhotosCopy.shared.PHOTOS_LABELS)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            } icon: {
                CentraidIconView(iconKey: "Tag", tint: Theme.color("textSoft", scheme))
            }
            let chips = state.labelChips
            if chips.isEmpty {
                Text(
                    state.isUnread(.labels)
                        ? PhotosCopy.shared.PHOTOS_LABELS_UNREADABLE
                        : PhotosCopy.shared.PHOTOS_LABELS_NONE
                )
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
            }
            ForEach(chips, id: \.label) { chip in
                HStack(spacing: 4) {
                    Text(chip.label).centraidType("small")
                    if !chip.tagID.isEmpty {
                        Button {
                            send(PhotoLightboxStateView.tagRemovedEvent(chip.tagID))
                        } label: {
                            CentraidIconView(iconKey: "X", tint: Theme.color("textSoft", scheme), size: 14)
                                .frame(width: 34, height: 34)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(copyFill(PhotosCopy.shared.PHOTOS_REMOVE_ITEM, "label", chip.label))
                    }
                }
                .padding(.leading, 10)
                .background(
                    Theme.color("bgSunken", scheme),
                    in: RoundedRectangle(cornerRadius: Theme.radius("md", scheme), style: .continuous)
                )
            }
            TextField(PhotosCopy.shared.PHOTOS_ADD_LABEL, text: $tag)
                .centraidType("body")
                .submitLabel(.done)
                .accessibilityLabel(PhotosCopy.shared.PHOTOS_ADD_LABEL)
                .onSubmit {
                    let label = tag.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !label.isEmpty else { return }
                    send(PhotoLightboxStateView.tagAddedEvent(label))
                    tag = ""
                }
        }
    }

    private func label(_ text: String) -> some View {
        Text(text)
            .centraidType("small")
            .foregroundStyle(Theme.color("textSoft", scheme))
    }

    private func textAction(_ title: String, action: @escaping () -> Void) -> some View {
        KitLink(label: title, action: action)
    }
}

/// The verbs the bottom row carries (Edit is `PhotoEditButton`'s).
///
/// `PhotoLightboxMachine.Verb` is the tested statement of which are refused and
/// why; this is the drawing of them. **Only keys that exist in
/// `CentraidCatalog.icons`** — an unknown key draws NOTHING, silently, which is
/// the failure that made the More tab render as a dash.
enum PhotoLightboxVerb: String {
    case share
    case favorite
    case info
    case archive
    case trash

    var iconKey: String {
        switch self {
        case .share: return "share"
        case .favorite: return "heart"
        case .info: return "info"
        case .archive: return "Archive"
        case .trash: return "trash"
        }
    }

    var identifier: String { rawValue }

    /// ICON-ONLY CONTROLS ARE NEVER UNLABELLED (§18), and a toggle's label
    /// says what the NEXT press does rather than what is currently true.
    func label(on: Bool) -> String {
        switch self {
        case .share: return PhotosCopy.shared.PHOTOS_SEND_COPY
        case .favorite: return on ? PhotosCopy.shared.PHOTOS_UNFAVORITE : PhotosCopy.shared.PHOTOS_FAVORITE
        case .info: return PhotosCopy.shared.PHOTOS_INFO
        case .archive: return on ? PhotosCopy.shared.PHOTOS_UNARCHIVE : PhotosCopy.shared.PHOTOS_ARCHIVE
        case .trash: return PhotosCopy.shared.PHOTOS_DELETE
        }
    }
}

/// How much of the place travels with a copy: `PhotoLightboxBridge.kt`'s
/// `SharePlacePrecision`, by its name (the raw value is that name, lowercased),
/// as `PhotoHandOff` prepares the copy for it.
enum PhotoLightboxSharePlace: String {
    case none
    case name
    case exact
}

/// One row of the share sheet.
struct PhotoLightboxShareRow {
    let precision: PhotoLightboxSharePlace
    let label: String
    let detail: String
}

/// The decoder between the lightbox's bytes and the view above.
///
/// Its own struct in its own file rather than an addition to
/// `StateViews.swift`, which is shared and would collide with every other lane
/// in this port. It decodes ONCE, in `init`: a view reads a dozen properties
/// off it per frame, and a decode per property read is a dozen decodes of a
/// message that carries a filmstrip.
struct PhotoLightboxStateView {
    let state: Centraid_Screen_V1_PhotoLightboxState

    init(data: Data) {
        state = (try? Centraid_Screen_V1_PhotoLightboxState(serializedBytes: data)) ?? .init()
    }

    /// Loading, a failure with a sentence, or the photograph. Three cases,
    /// always — and the `nil` a message with no content set decodes to is the
    /// SAME screen as loading: a state that has not read yet.
    var content: ScreenContent<Centraid_Screen_V1_PhotoDetail> {
        switch state.content {
        case let .failure(failure):
            return .failure(failure.sentence, failure.remedy)
        case let .detail(detail):
            return .data(detail)
        case let .loading(loading):
            return .loading(loading.firstLoad)
        case .none:
            return .loading(true)
        }
    }

    var detail: Centraid_Screen_V1_PhotoDetail? {
        if case let .detail(value) = state.content { return value }
        return nil
    }

    var assetID: String { state.assetID }
    var hasDetail: Bool { detail != nil }

    /// THE SENTENCE A REFUSED WRITE LEFT BEHIND, or nil.
    ///
    /// `write_failure` and never the `content` oneof's `failure`: that slot is
    /// the READ's, and a denied favourite put there would replace the
    /// photograph with an error text.
    var writeFailure: String? {
        guard state.hasWriteFailure, !state.writeFailure.sentence.isEmpty else { return nil }
        return state.writeFailure.remedy.isEmpty
            ? state.writeFailure.sentence
            : "\(state.writeFailure.sentence) \(state.writeFailure.remedy)"
    }

    var chromeVisible: Bool { state.chromeVisible }
    var slideshow: Bool { state.slideshow }
    var notice: String { state.notice }
    var albumID: String { state.albumID }
    var albumChoices: [Centraid_Screen_V1_AlbumChoiceEntry] { state.albumChoices }
    var albumChoiceOpen: Bool { state.albumChoiceOpen }
    var placeChoices: [Centraid_Screen_V1_PhotoPlaceChoice] { state.placeChoices }
    var sheet: Centraid_Screen_V1_PhotoLightboxState.Sheet { state.sheet }
    var neighbours: [String] { state.neighbourAssetIds }
    var isArchived: Bool { detail?.archived ?? false }
    var title: String { detail.map(Self.title) ?? PhotosCopy.shared.PHOTOS_THIS_PHOTO }
    var caption: String { detail?.title ?? "" }
    var camera: String { detail?.camera ?? "" }
    var placeID: String { detail?.placeID ?? "" }
    var placeHasCoordinate: Bool { detail?.placeHasCoordinate ?? false }
    var isVideo: Bool { detail?.kind == .video }
    var originalMediaType: String { detail?.originalMediaType ?? "" }

    /// The sheet on screen, or none. The album choice is a sheet of its own
    /// state (`album_choice_open`, the shared sheet's contract) and wins.
    var presentedSheet: LightboxSheetItem? {
        if state.albumChoiceOpen { return LightboxSheetItem(kind: .album) }
        switch state.sheet {
        case .info: return LightboxSheetItem(kind: .info)
        case .share: return LightboxSheetItem(kind: .share)
        case .more: return LightboxSheetItem(kind: .more)
        case .place: return LightboxSheetItem(kind: .place)
        default: return nil
        }
    }

    // MARK: - What the stage draws

    /// The original's path as the byte door answered it, drawable or not —
    /// the copy a member sends is not the picture this screen draws.
    var originalPath: String? {
        guard let detail, detail.hasOriginalPath, !detail.originalPath.isEmpty else { return nil }
        return detail.originalPath
    }

    /// THE ORIGINAL, when the byte door located it here AND said it may be
    /// drawn — `embeddable` is a security answer, not a hint.
    var drawableOriginal: String? {
        guard let detail, !isVideo, detail.originalEmbeddable else { return nil }
        return originalPath
    }

    /// The video's own file, when it can be played.
    var videoPath: String? {
        guard let detail, isVideo, detail.originalEmbeddable else { return nil }
        return originalPath
    }

    /// A Live Photo's movie, once located.
    var livePath: String? {
        guard let detail, detail.hasLivePath, !detail.livePath.isEmpty else { return nil }
        return detail.livePath
    }

    /// What the players are made from; a change is a new player.
    var mediaKey: String { "\(videoPath ?? "")|\(livePath ?? "")" }

    var drawablePath: String? {
        guard let detail else { return nil }
        if let drawableOriginal { return drawableOriginal }
        if detail.hasThumbnailPath, !detail.thumbnailPath.isEmpty { return detail.thumbnailPath }
        return nil
    }

    /// A neighbour's strip frame, when the strip has read it.
    func framePath(_ identifier: String) -> String? {
        guard let cell = state.film.first(where: { $0.assetID == identifier }),
              cell.hasThumbnailPath, !cell.thumbnailPath.isEmpty
        else { return nil }
        return cell.thumbnailPath
    }

    /// The photograph's own thumbnail once its read lands, its strip frame
    /// before.
    func thumbnailPath(for identifier: String) -> String? {
        if let detail, detail.assetID == identifier, detail.hasThumbnailPath,
           !detail.thumbnailPath.isEmpty {
            return detail.thumbnailPath
        }
        return framePath(identifier)
    }

    /// An image-only stage carries a description even when there is no image
    /// — which is when it matters most.
    var stageLabel: String {
        guard let detail else { return PhotosCopy.shared.PHOTOGRAPH }
        if drawablePath != nil { return Self.title(detail) }
        switch detail.held {
        case .absent: return PhotosCopy.shared.PHOTOS_NOT_ON_PHONE
        default: return PhotosCopy.shared.PHOTOS_PREVIEW_GONE
        }
    }

    // MARK: - The strip and the slideshow

    /// The neighbours within reach either side of the photograph on screen —
    /// `PhotoLightboxMachine.filmWindow`, called with the two fields it is a
    /// function of (SwiftProtobuf's state cannot cross into Wire's functions).
    var filmWindow: [String] {
        PhotoLightboxMachine.shared.filmWindow(neighbours: neighbours, assetId: assetID)
    }

    /// Where the window starts on the shelf, for "3 of 184".
    var filmOffset: Int {
        Int(PhotoLightboxMachine.shared.filmOffset(neighbours: neighbours, assetId: assetID))
    }

    /// `PhotoLightboxMachine.SLIDESHOW_INTERVAL_MS`, in nanoseconds, for the
    /// clock the shell owns.
    static var slideshowNanoseconds: UInt64 {
        UInt64(PhotoLightboxMachine.shared.SLIDESHOW_INTERVAL_MS) * 1_000_000
    }

    /// v0's slideshow status line.
    static let slideshowLine = PhotosCopy.shared.PHOTOS_SLIDESHOW_LINE

    /// `12 of 184, 4 seconds a photo` — filled by the shared machine.
    var slideshowMeta: String { state.slideshowMeta }

    // MARK: - The words

    // EVERY LINE BELOW IS THE SHARED MACHINE'S (`PhotoLightboxText`): the
    // reducer fills them after each step, so this shell draws sentences and
    // decides none.

    /// `30 July 2026`, or empty when the row records no capture time.
    var stampDate: String { state.stampDate }

    /// `17:42 · Lyme Regis`.
    var stampLine: String { state.stampLine }

    /// THE STAGE'S ONE LINE, and nothing when there is nothing to say. The one
    /// input the shell owns is whether it has a player on the video.
    func statusLine(playing: Bool) -> String {
        playing ? state.statusLinePlaying : state.statusLine
    }

    var isFetching: Bool { detail?.held == .fetching }

    /// `nil` when the byte plane cannot say how far it has got, which is a
    /// different thing from nought and draws a different control.
    var fetchFraction: Double? {
        guard let detail, detail.held == .fetching, detail.fetchPercent > 0 else { return nil }
        return Double(min(detail.fetchPercent, 100)) / 100
    }

    /// THE DOWNLOAD ARROW IS OFFERED ONLY FOR `withheld_by_rule`, and only with
    /// a hash to name. A photograph still on its way gets none.
    var offersFetch: Bool {
        guard let detail else { return false }
        return detail.held == .withheldByRule && !detail.originalHash.isEmpty
    }

    var whereabouts: String { state.whereabouts }

    /// The facts panel's rows, in order.
    var facts: [Centraid_Screen_V1_PhotoLightboxFact] { state.facts }

    /// WHERE, as the vault names it — never a coordinate.
    var placeLine: String {
        guard let detail else { return "" }
        if !detail.placeName.isEmpty { return detail.placeName }
        if isUnread(.place) { return PhotosCopy.shared.PHOTOS_PLACE_UNREADABLE }
        return detail.placeID.isEmpty ? PhotosCopy.shared.PHOTOS_PLACE_NONE : PhotosCopy.shared.PLACE_UNNAMED
    }

    /// Only labels with a word on them, each with the edge a remove takes off.
    var labelChips: [(label: String, tagID: String)] {
        (detail?.labels ?? [])
            .filter { !$0.label.isEmpty }
            .map { ($0.label, $0.tagID) }
    }

    var archiveVerb: String { isArchived ? PhotosCopy.shared.PHOTOS_UNARCHIVE : PhotosCopy.shared.PHOTOS_ARCHIVE }

    /// WAS THIS PART REFUSED? A refused tag read must not replace the
    /// photograph with a sentence, and it must not vanish either.
    func isUnread(_ part: Centraid_Screen_V1_PhotoDetail.Part) -> Bool {
        detail?.unreadParts.contains(part) ?? false
    }

    // MARK: - The pager

    private var index: Int? { neighbours.firstIndex(of: assetID) }
    var previous: String? {
        guard let index, index > 0 else { return nil }
        return neighbours[index - 1]
    }

    var next: String? {
        guard let index, index + 1 < neighbours.count else { return nil }
        return neighbours[index + 1]
    }

    // MARK: - The verbs

    /// v0's refusal ladder (`viewer-write-refusal.ts`), as the reducer decided
    /// it — the same sentence that GATES the command. `nil` means every write
    /// is live.
    var refusal: String? {
        state.writeRefusal.isEmpty ? nil : state.writeRefusal
    }

    /// WHY EDIT IS REFUSED, or `nil` when it is live: decided by
    /// `PhotoEditorMachine.editRefusal` and filled onto the state.
    var editRefusal: String? {
        state.editRefusal.isEmpty ? nil : state.editRefusal
    }

    func isEnabled(_ verb: PhotoLightboxVerb) -> Bool {
        // INFO AND SHARE ONLY READ.
        switch verb {
        case .info, .share: return detail != nil
        case .favorite, .archive, .trash: return refusal == nil
        }
    }

    /// `sharePlaceOptions(placeName, located)`, the shared rows, drawn here.
    var shareChoices: [PhotoLightboxShareRow] {
        PhotoLightboxBridgeKt.sharePlaceOptions(placeName: detail?.placeName ?? "", located: placeHasCoordinate)
            .compactMap { option in
                PhotoLightboxSharePlace(rawValue: option.precision.name.lowercased()).map {
                    PhotoLightboxShareRow(precision: $0, label: option.label, detail: option.detail)
                }
            }
    }

    // MARK: - Events

    func event(for verb: PhotoLightboxVerb, on: Bool) -> Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        switch verb {
        case .favorite:
            event.favorite = .with { $0.favorite = !on }
        case .archive:
            event.archive = .with { $0.archived = !on }
        case .trash:
            // INTO THE TRASH, NEVER OUT OF THE VAULT. `permanent` is a separate
            // decision with its own confirmation and the trash shelf is where
            // it is made.
            event.delete = .with { $0.permanent = false }
        case .info:
            event.sheet = .with { $0.sheet = .info }
        case .share:
            event.sheet = .with { $0.sheet = .share }
        }
        return Self.encoded(event)
    }

    /// CLOSE WHATEVER IS OPEN.
    ///
    /// Its own property rather than `sheetEvent(.none)`, because the generated
    /// case IS called `none` and that line is one Swift resolves against
    /// `Optional` as readily as against the enum. Spelled once, here.
    var closeSheetEvent: Data {
        sheetEvent(Centraid_Screen_V1_PhotoLightboxState.Sheet.none)
    }

    func sheetEvent(_ sheet: Centraid_Screen_V1_PhotoLightboxState.Sheet) -> Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.sheet = .with { $0.sheet = sheet }
        return Self.encoded(event)
    }

    func chromeEvent(_ visible: Bool) -> Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.chrome = .with { $0.visible = visible }
        return Self.encoded(event)
    }

    func movedEvent(_ assetIdentifier: String) -> Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.moved = .with { $0.assetID = assetIdentifier }
        return Self.encoded(event)
    }

    func slideshowEvent(_ playing: Bool) -> Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.slideshow = .with { $0.playing = playing }
        return Self.encoded(event)
    }

    static var slideshowAdvancedEvent: Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.slideshowAdvanced = .init()
        return encoded(event)
    }

    var fetchEvent: Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.fetchOriginal = .with {
            $0.assetID = assetID
            $0.contentHash = detail?.originalHash ?? ""
        }
        return Self.encoded(event)
    }

    static func captionEvent(_ caption: String) -> Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.caption = .with { $0.caption = caption }
        return encoded(event)
    }

    static func tagAddedEvent(_ label: String) -> Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.tagAdded = .with { $0.label = label }
        return encoded(event)
    }

    static func tagRemovedEvent(_ tagIdentifier: String) -> Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.tagRemoved = .with { $0.tagID = tagIdentifier }
        return encoded(event)
    }

    /// Empty clears the photograph's place.
    static func placeChosenEvent(_ placeIdentifier: String) -> Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.placeChosen = .with { $0.placeID = placeIdentifier }
        return encoded(event)
    }

    static var keyPhotoEvent: Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.keyPhoto = .init()
        return encoded(event)
    }

    static func handOffEvent(_ outcome: PhotoHandOff.Outcome) -> Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.handOffSettled = .with {
            $0.done = outcome.done
            $0.sentence = outcome.sentence
        }
        return encoded(event)
    }

    static var albumChoiceOpenedEvent: Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.albumChoiceOpened = .init()
        return encoded(event)
    }

    static var albumChoiceDismissedEvent: Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.albumChoiceDismissed = .init()
        return encoded(event)
    }

    static func albumChosenEvent(_ albumIdentifier: String) -> Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.albumChosen = .with { $0.albumID = albumIdentifier }
        return encoded(event)
    }

    static func cameraReadEvent(assetIdentifier: String, camera: String) -> Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.cameraRead = .with {
            $0.assetID = assetIdentifier
            $0.camera = camera
        }
        return encoded(event)
    }

    static func albumCreatedEvent(_ title: String) -> Data {
        var event = Centraid_Screen_V1_PhotoLightboxEvent()
        event.albumChoiceCreated = .with { $0.title = title }
        return encoded(event)
    }

    /// The bytes that cross back into `CentraidShared`.
    ///
    /// A serialisation that throws yields EMPTY bytes rather than a crash, and
    /// the shared module decodes those as a message with no `kind` set, which
    /// the reducer's `else` branch answers with `Step(state)`.
    static func encoded(_ event: Centraid_Screen_V1_PhotoLightboxEvent) -> Data {
        (try? event.serializedData()) ?? Data()
    }

    // MARK: - Formatting

    /// `timeline-engine` flattens a caption and a file name into one field, so
    /// a value still SHAPED like a file name was never captioned: it is a
    /// last-resort fallback and never a caption.
    private static func title(_ detail: Centraid_Screen_V1_PhotoDetail) -> String {
        let trimmed = detail.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? PhotosCopy.shared.PHOTOGRAPH : trimmed
    }
}
