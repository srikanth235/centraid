import SwiftUI

/// What a lightbox view sends: one arm of `PhotosLightboxEvent`.
typealias PhotosLightboxSend = Centraid_Core_V1_PhotosLightboxEvent.OneOf_Kind

/// ONE PHOTOGRAPH, FULL BLEED (#1135): `photos.lightbox`, drawn. Rust decides
/// every word, every verb and the reason one cannot run; this draws
/// `PhotosLightboxState` and sends `PhotosLightboxEvent`s, and keeps only what no
/// one else can: the players, the gestures and the typed text. The Compose twin
/// is `PhotosLightboxScreen.kt`.
///
/// 1. **A STAGE, NOT A PAGE.** The photograph is the screen. Chrome floats over it
///    and goes away with a tap; chrome is a state (`chrome_visible`), not an
///    animation, so a member who put the bars away and rotated the phone does not
///    get them back.
/// 2. **EVERY VERB IS LIVE OR VISIBLY REFUSED**, and the refusal is drawn as text
///    and not only spoken (the toolbar's `why`).
/// 3. **A MODE.** The slideshow is this screen with a clock Rust owns.
struct PhotosLightboxView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let state: Centraid_Core_V1_PhotosLightboxState
    let send: (PhotosLightboxSend) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onClose: () -> Void

    /// The screen's players: a video's, and a Live Photo's movie.
    @StateObject private var media = LightboxMedia()

    var body: some View {
        let model = PhotosLightboxModel(state: state)
        // A SCREEN READER PINS THE CHROME OPEN: a control reachable only by an
        // unlabelled full-screen tap is not reachable at all under VoiceOver.
        let chromeVisible = state.chromeVisible || voiceOver || state.slideshow
        ZStack {
            if state.slideshow {
                darkStage(model, chromeVisible: chromeVisible)
            } else {
                lightPage(model)
            }
        }
        // THE STAGE ROOM TAKES NO HEADER (product-intuition/references/design-behaviour.md § Rooms): its way out is the close
        // chip and the swipe down, both the same act.
        .toolbar(.hidden, for: .navigationBar)
        .sheet(item: sheetBinding) { item in
            sheet(item.kind)
        }
        .linkPickerSheet(state.peoplePicker) { link in send(.people(link)) }
        .onChange(of: model.mediaKey, initial: true) { _, _ in
            media.update(
                videoPath: model.videoPath,
                mediaType: model.originalMediaType,
                livePath: model.livePath
            )
        }
        .onChange(of: state.dismissed, initial: true) { _, gone in
            if gone { onClose() }
        }
    }

    // MARK: - The slideshow: the dark stage

    /// THE SLIDESHOW IS A MODE, and a mode is the stage: full bleed on the darkest surface, the
    /// chrome floating over it. Every other viewing is the light page ([lightPage]).
    @ViewBuilder
    private func darkStage(_ model: PhotosLightboxModel, chromeVisible: Bool) -> some View {
        ZStack {
            // THE STAGE IS THE DARKEST SURFACE AND IT IS NOT THE PAGE.
            Theme.color("stage", scheme).ignoresSafeArea()
            switch state.page.state {
            case .loading?, .empty?:
                // BEFORE THE READ LANDS THE STAGE STILL DRAWS what it has — the
                // strip frame of the photograph a member swiped to — and a ring
                // only over a stage with nothing at all.
                stage(model).ignoresSafeArea()
                if model.framePath(state.photoID) == nil {
                    Text(state.words.opening)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("onStageSoft", scheme))
                }
            case let .refused(denied)?:
                DeniedGate(denied)
            case let .failed(failure)?:
                ScreenFailureView(sentence: failure.sentence, remedy: failure.remedy)
                    .padding(CentraidGeometry.pageMargin)
            case nil:
                let photo = state.photo
                stage(model).ignoresSafeArea()
                if model.drawablePath == nil {
                    // NEVER A BROKEN IMAGE. Each of these is a truthful state.
                    Text(photo.stageLabel)
                        .centraidType("body")
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Theme.color("onStage", scheme))
                        .padding(CentraidGeometry.pageMargin)
                        .allowsHitTesting(false)
                }
                if chromeVisible { chrome(photo) }
            }
        }
    }

    // MARK: - The viewer: a light page

    /// THE VIEWER IS A LIGHT PAGE (#1173, the Photo viewer board): the way out, the stamp and the
    /// menu across the top; the photograph in a band of its own; then the cards that say what the
    /// vault knows about it (caption, when and with what, place and labels, where the original
    /// is); and the floating bar of verbs. The photograph keeps every gesture it had (page,
    /// zoom, swipe down), inside its band.
    @ViewBuilder
    private func lightPage(_ model: PhotosLightboxModel) -> some View {
        // THE VIEWER OPENS PHOTO-ONLY, the details closed every time (Rust's `sheet`): (i) or a swipe
        // up opens them and the photograph shrinks up, (i) or a swipe down closes them.
        let infoOpen = state.sheet == .info
        ZStack(alignment: .bottom) {
            Surface.page.ignoresSafeArea()
            VStack(spacing: 0) {
                lightHeader()
                // THE FIRST READ DRAWS THE BAND ALONE (the frame is already known from the film); a
                // failed or refused one the shared failure or gate; a failed re-read keeps the
                // photograph under the one-sentence note.
                PageReadStateView(
                    page: state.page,
                    onRetry: { send(.refreshed(.init())) },
                    skeleton: { band(model, photo: nil, infoOpen: false) },
                    data: {
                        if state.hasPhoto {
                            let photo = state.photo
                            band(model, photo: photo, infoOpen: infoOpen)
                            if infoOpen {
                                ScrollView {
                                    PhotosLightboxInfo(state: state, photo: photo, send: send, open: open)
                                        .padding(.bottom, 16)
                                }
                                .scrollDismissesKeyboard(.interactively)
                                .kitTransition(.move(edge: .bottom).combined(with: .opacity))
                            }
                            // THE BAR NEVER COVERS THE DETAILS: it is the page's last row, so the photograph and
                            // the cards are laid out above it and the Place card's links are never under it.
                            lightToolbar(photo)
                        }
                    }
                )
            }
        }
        .animation(reduceMotion ? nil : .timingCurve(0.3, 0, 0.4, 1, duration: CentraidGeometry.durationOne / 1000), value: infoOpen)
        .appAccent("photos")
    }

    /// The top row: close, the stamp (WHEN outranks WHAT), the menu.
    private func lightHeader() -> some View {
        let stamp = { () -> (String, String) in
            if state.hasPhoto { return (state.photo.stampDate, state.photo.stampLine) }
            return ("", "")
        }()
        return HStack(alignment: .center) {
            chip(icon: "ChevronLeft", label: state.words.close, light: true, action: onClose)
                .accessibilityIdentifier("photos.lightbox.close")
            Spacer()
            VStack(spacing: 2) {
                if !stamp.0.isEmpty { Text(stamp.0).kitType(.row).fontWeight(.semibold).foregroundStyle(Surface.ink) }
                if !stamp.1.isEmpty { Text(stamp.1).kitType(.meta).foregroundStyle(Surface.meta) }
            }
            Spacer()
            moreMenu(light: true)
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
    }

    /// THE PHOTOGRAPH'S BAND: the stage, on its own ground, with what plays or loads over its foot.
    private func band(_ model: PhotosLightboxModel, photo: Centraid_Core_V1_PhotosLightboxPhoto?, infoOpen: Bool) -> some View {
        ZStack(alignment: .bottom) {
            // THE LIGHT GROUND, no black letterbox: the photograph sits on the page itself.
            Surface.page
            stage(model)
            if let photo, model.drawablePath == nil {
                // NEVER A BROKEN IMAGE. Each of these is a truthful state.
                Text(photo.stageLabel)
                    .centraidType("body")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Surface.ink)
                    .padding(CentraidGeometry.pageMargin)
                    .allowsHitTesting(false)
                    .frame(maxHeight: .infinity)
            } else if photo == nil, model.framePath(state.photoID) == nil {
                Text(state.words.opening)
                    .centraidType("small")
                    .foregroundStyle(Surface.meta)
                    .frame(maxHeight: .infinity)
            }
            if let photo {
                VStack(spacing: 4) {
                    if let live = media.live {
                        LiveChip(live: live, words: state.words)
                    }
                    statusLine(photo)
                    if let video = media.video {
                        LightboxTransport(player: video, words: state.words)
                            .padding(.horizontal, CentraidGeometry.pageMargin)
                    }
                }
                .padding(.bottom, 4)
            }
        }
        // OPEN, THE PHOTOGRAPH SHRINKS UP to a band; closed, it takes the whole page.
        .modifier(PhotosBandHeight(shrunk: infoOpen))
        .clipped()
    }

    /// THE BAR OF VERBS, floating at the foot: the same verbs as ever, in the page's ink.
    private func lightToolbar(_ photo: Centraid_Core_V1_PhotosLightboxPhoto) -> some View {
        VStack(spacing: 4) {
            if state.hasStatus, !state.status.sentence.isEmpty, !state.status.refused {
                HStack(spacing: 8) {
                    Text(state.status.sentence)
                        .kitType(.meta)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Surface.meta)
                        .accessibilityIdentifier("photos.lightbox.status")
                    statusAction(Surface.ink, "photos-lightbox-status-action")
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
            }
            toolbar(light: true)
        }
        .padding(.bottom, 8)
    }

    private func stage(_ model: PhotosLightboxModel) -> some View {
        PhotosLightboxStage(
            state: model,
            player: media.video,
            live: media.live,
            send: send,
            onClose: onClose,
            infoOpen: state.sheet == .info && !state.slideshow,
            onInfo: { open in send(sheetEvent(open ? .info : .none)) }
        )
    }

    // MARK: - The chrome

    @ViewBuilder
    private func chrome(_ photo: Centraid_Core_V1_PhotosLightboxPhoto) -> some View {
        VStack(spacing: 0) {
            // THREE FLOATING THINGS ACROSS THE TOP: the way out, the stamp and
            // the menu. The stamp takes the middle because it is the only one
            // that is not a control: WHEN outranks WHAT.
            HStack(alignment: .top) {
                chip(icon: "ChevronLeft", label: state.words.close, action: onClose)
                    .accessibilityIdentifier("photos.lightbox.close")
                Spacer()
                VStack(spacing: 2) {
                    let title = state.slideshow ? state.words.slideshow : photo.stampDate
                    let meta = state.slideshow ? state.slideshowMeta : photo.stampLine
                    if !title.isEmpty { Text(title).centraidType("control") }
                    if !meta.isEmpty {
                        Text(meta)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("onStageSoft", scheme))
                    }
                }
                .foregroundStyle(Theme.color("onStage", scheme))
                Spacer()
                // THE ONE WAY OUT OF THE SLIDESHOW, named for what it does.
                Button {
                    send(.slideshowLeft(.init()))
                } label: {
                    Text(state.words.slideshowLeave)
                        .centraidType("control")
                        .foregroundStyle(Theme.color("onStage", scheme))
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("photos.lightbox.leaveSlideshow")
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)

            Spacer()

            if !state.slideshow, let live = media.live {
                LiveChip(live: live, words: state.words).padding(.bottom, 8)
            }

            statusLine(photo)

            // A WRITE THAT WAS REFUSED, OR A RECEIPT, AS A LINE OVER THE CHROME:
            // over it and never instead of the photograph.
            if state.hasStatus, !state.status.sentence.isEmpty {
                // ON ITS OWN PLATE, clear of the photograph's pixels beneath it.
                HStack(spacing: 8) {
                    Text(state.status.sentence)
                        .centraidType("small")
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Theme.color("onStage", scheme))
                    statusAction(Theme.color("onStage", scheme), "photos-lightbox-status-action")
                }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(Theme.color("stageSunken", scheme), in: Capsule())
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.bottom, 8)
                    .accessibilityIdentifier("photos.lightbox.status")
            }

            if !state.slideshow {
                if let video = media.video {
                    LightboxTransport(player: video, words: state.words)
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                }
                // THE FILMSTRIP SITS DIRECTLY ABOVE THE PAGER AND THE ROW, and
                // goes away with the rest of the chrome.
                LightboxFilmstrip(state: PhotosLightboxModel(state: state), send: send)
                    .padding(.bottom, 4)
                toolbar()
            }
        }
        .padding(.vertical, 8)
    }

    /// The status line's action ("Undo" after Move to trash, #1185); empty label, no button.
    @ViewBuilder
    private func statusAction(_ ink: Color, _ identifier: String) -> some View {
        if state.hasStatus, !state.status.actionLabel.isEmpty {
            Button { send(.statusActed(.init())) } label: {
                Text(state.status.actionLabel)
                    .kitType(.meta)
                    .fontWeight(.semibold)
                    .foregroundStyle(ink)
                    .frame(minHeight: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(identifier)
        }
    }

    /// THE ONE STATUS LINE, drawn only when it has something to say.
    @ViewBuilder
    private func statusLine(_ photo: Centraid_Core_V1_PhotosLightboxPhoto) -> some View {
        let line = state.slideshow
            ? state.slideshowLine
            : (media.video != nil ? photo.statusLinePlaying : photo.statusLine)
        if !line.isEmpty || (photo.offersFetch && !state.slideshow) || photo.fetching {
            HStack(spacing: 8) {
                if !state.slideshow, photo.fetching { StageSpinner() }
                if !line.isEmpty {
                    Text(line)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("onStageSoft", scheme))
                        .accessibilityIdentifier("photos.lightbox.status.line")
                }
                if !state.slideshow, photo.offersFetch {
                    Button {
                        send(.fetchOriginal(.init()))
                    } label: {
                        Text(state.words.loadOriginal)
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

    private func pagerButton(icon: String, label: String, target: String, light: Bool = false) -> some View {
        Button {
            if !target.isEmpty { send(.moved(.with { $0.photoID = target })) }
        } label: {
            CentraidIconView(
                iconKey: icon,
                tint: light
                    ? (target.isEmpty ? Surface.meta : Surface.ink)
                    : Theme.color(target.isEmpty ? "onStageSoft" : "onStage", scheme),
                size: 20
            )
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(target.isEmpty)
        .accessibilityLabel(label)
    }

    /// THE BOTTOM ROW. Every verb is live or visibly refused, and the refusal is
    /// a VISIBLE sentence and not only an accessibility hint.
    private func toolbar(light: Bool = false) -> some View {
        let reasons = Array(Set(state.toolbar.filter { !$0.enabled && !$0.why.isEmpty }.map(\.why))).sorted()
        var trashed = false
        if state.hasPhoto { trashed = state.photo.trashed }
        // THE POINTER EQUIVALENT FOR SWIPE: nothing here is reachable by gesture alone.
        // The arrows are the ends of the one row, so they line up with the verbs between
        // them; the ids are Rust's `previous_id` and `next_id`, empty at either end.
        let paged = !state.previousID.isEmpty || !state.nextID.isEmpty
        return VStack(spacing: 4) {
            HStack(spacing: 0) {
                if paged {
                    pagerButton(icon: "ChevronLeft", label: state.words.previous, target: state.previousID, light: light)
                }
                ForEach(state.toolbar, id: \.kind.rawValue) { verb in
                    toolbarKey(verb, labelled: trashed, light: light)
                        .frame(maxWidth: .infinity)
                }
                if paged {
                    pagerButton(icon: "ChevronRight", label: state.words.next, target: state.nextID, light: light)
                }
            }
            // A FLOATING BAR in Liquid Glass on iOS 26, solid before it and under Reduce
            // Transparency or Increase Contrast.
            .padding(.horizontal, 8)
            .modifier(PhotosStageGlass(shape: Capsule(), solid: light ? Surface.card : Theme.color("stageSunken", scheme)))
            ForEach(reasons, id: \.self) { reason in
                Text(reason)
                    .centraidType("small")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(light ? Surface.meta : Theme.color("onStageSoft", scheme))
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
    }

    /// ONE VERB OF THE BAR. A toggle that is ON is drawn solid (a filled star) and is
    /// announced as selected; over a trashed photograph the verbs carry their words, because
    /// a restore and a delete-forever side by side are two marks a member must tell apart.
    private func toolbarKey(_ verb: Centraid_Core_V1_PhotosLightboxVerb, labelled: Bool = false, light: Bool = false) -> some View {
        Button {
            guard verb.enabled else { return }
            // Edit is a page: the shell pushes the route Rust built.
            if verb.hasRoute { open(verb.route) } else { send(verbEvent(verb)) }
        } label: {
            // A LIT TOGGLE (the favourite) wears the app's colour, never amber.
            let rest = light ? Surface.ink : Theme.color("onStage", scheme)
            let soft = light ? Surface.meta : Theme.color("onStageSoft", scheme)
            let ink = verb.enabled && verb.on
                ? (light ? AppAccent("photos").text : AppAccent("photos").tile)
                : (verb.enabled ? (verb.destructive ? Theme.color("net", scheme) : rest) : soft)
            VStack(spacing: 2) {
                CentraidIconView(
                    iconKey: verb.iconKey,
                    // A REFUSED TARGET IS GREYED WITH THE STAGE'S OWN SOFT INK, never
                    // the page's disabled ink.
                    tint: ink,
                    size: 24,
                    solid: verb.on
                )
                if labelled {
                    Text(verb.label)
                        .centraidType("small")
                        .foregroundStyle(ink)
                        .lineLimit(1)
                }
            }
            .frame(minWidth: 44, minHeight: 44)
            .background(
                light && verb.kind == .info && verb.on ? Surface.fill : Color.clear,
                in: Circle()
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!verb.enabled)
        .accessibilityLabel(verb.label)
        .accessibilityHint(verb.enabled ? "" : verb.why)
        .accessibilityAddTraits(verb.on ? .isSelected : [])
        .accessibilityIdentifier("photos.lightbox.\(verb.iconKey)")
    }

    /// One round plate around one control: 44pt exactly, a plate and not a chip.
    private func chip(icon: String, label: String, light: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            chipFace(icon: icon, light: light)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func chipFace(icon: String, light: Bool) -> some View {
        CentraidIconView(iconKey: icon, tint: light ? Surface.ink : Theme.color("onStage", scheme), size: 20)
            .frame(width: 44, height: 44)
            .modifier(PhotosStageGlass(shape: Circle(), solid: light ? Surface.card : Theme.color("stageSunken", scheme)))
    }

    // MARK: - The sheets

    /// ONE `.sheet(item:)` FOR ALL OF THEM: moving from Info to the place picker,
    /// or from More to the album choice, is one item replacing another. A
    /// swipe-to-dismiss reaches Rust too, or the state would still say INFO with
    /// nothing on screen and the next tap on Info would be a no-op.
    private var sheetBinding: Binding<LightboxSheetItem?> {
        Binding(
            get: { presentedSheet },
            set: { item in
                guard item == nil else { return }
                if state.albumChoice.open {
                    send(.albumChoice(.with { $0.kind = .dismissed(.init()) }))
                } else if state.hasConfirm {
                    send(.confirmDismissed(.init()))
                } else if state.sheet != .none {
                    send(sheetEvent(.none))
                }
            }
        )
    }

    private var presentedSheet: LightboxSheetItem? {
        if state.albumChoice.open { return LightboxSheetItem(kind: .album) }
        if state.hasConfirm { return LightboxSheetItem(kind: .confirm) }
        switch state.sheet {
        case .info: return nil
        case .share: return LightboxSheetItem(kind: .share)
        case .place: return LightboxSheetItem(kind: .place)
        default: return nil
        }
    }

    @ViewBuilder
    private func sheet(_ kind: LightboxSheetItem.Kind) -> some View {
        switch kind {
        case .info:
            // THE CARDS ARE ON THE PAGE, so Info presents nothing.
            EmptyView()
        case .share:
            OptionSheet(title: state.words.shareTitle) {
                ForEach(state.shareChoices, id: \.precision.rawValue) { choice in
                    Button {
                        send(.share(.with { $0.precision = choice.precision }))
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
        case .place:
            PhotosLightboxPlaceSheet(state: state, send: send)
                .presentationDetents([.medium, .large])
        case .album:
            PhotosAlbumChoiceSheet(choice: state.albumChoice) { event in
                send(.albumChoice(event))
            }
        case .confirm:
            ConfirmSheet(
                state.confirm,
                onConfirm: { send(.confirmed(.init())) },
                onDismiss: { send(.confirmDismissed(.init())) }
            )
            .modifier(SheetPresentation(detents: ConfirmSheet.detents))
        }
    }

    /// THE "…" KEY IS THE PLATFORM'S OWN MENU, never a sheet (#1173): Rust's rows
    /// (`menu`), a refusal riding as the row's detail rather than a second, shorter
    /// phrasing of the same truth.
    private func moreMenu(light: Bool) -> some View {
        Menu {
            ForEach(state.menu, id: \.kind.rawValue) { verb in
                Button(role: verb.destructive ? .destructive : nil) {
                    send(verbEvent(verb))
                } label: {
                    Text(verb.enabled || verb.why.isEmpty ? verb.label : "\(verb.label) \u{2014} \(verb.why)")
                }
                .disabled(!verb.enabled)
                .accessibilityIdentifier("photos.lightbox.menu.\(verb.iconKey)")
            }
        } label: {
            chipFace(icon: "more", light: light)
        }
        .accessibilityLabel(state.words.more)
        .accessibilityIdentifier("photos.lightbox.more")
    }

    private func sheetEvent(_ sheet: Centraid_Core_V1_PhotosLightboxState.Sheet) -> PhotosLightboxSend {
        .sheet(.with { $0.sheet = sheet })
    }

    private func verbEvent(_ verb: Centraid_Core_V1_PhotosLightboxVerb) -> PhotosLightboxSend {
        .verb(.with { $0.kind = verb.kind })
    }
}

struct LightboxSheetItem: Identifiable, Equatable {
    enum Kind: String {
        case info, share, place, album, confirm
    }

    let kind: Kind
    var id: String { kind.rawValue }
}

// MARK: - Place and album sheets

/// "ADJUST LOCATION": the places this vault knows, and "No place". A place is
/// PICKED here and never typed.
private struct PhotosLightboxPlaceSheet: View {
    @Environment(\.colorScheme) private var scheme
    let state: Centraid_Core_V1_PhotosLightboxState
    let send: (PhotosLightboxSend) -> Void

    var body: some View {
        SheetRoom(title: state.words.placePickerTitle) {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    if state.hasStatus, state.status.refused, !state.status.sentence.isEmpty {
                        Text(state.status.sentence).centraidType("small").foregroundStyle(Theme.color("net", scheme))
                    }
                    ForEach(state.placeChoices, id: \.placeID) { place in
                        let detail = place.placeID.isEmpty
                            ? state.words.noPlaceDetail
                            : (place.here ? state.words.placeHere : "")
                        Button {
                            if !place.here { send(.placeChosen(.with { $0.placeID = place.placeID })) }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(place.name)
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
                    if state.placeChoices.count <= 1 {
                        Text(state.words.noPlaces)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

// MARK: - The info sheet

/// THE CARDS UNDER THE PHOTOGRAPH — everything the vault knows about it, and the four
/// things a member may change about it: the caption, the labels, the place, and a
/// copy of where it was taken. No destructive control here, ever: Trash lives on
/// the bar alone. A field the record lacks is omitted, never invented.
private struct PhotosLightboxInfo: View {
    @Environment(\.colorScheme) private var scheme
    let state: Centraid_Core_V1_PhotosLightboxState
    let photo: Centraid_Core_V1_PhotosLightboxPhoto
    let send: (PhotosLightboxSend) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    @State private var caption = ""
    @State private var captionFor = ""
    @State private var tag = ""
    @FocusState private var captionFocused: Bool

    var body: some View {
        let words = state.words
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                // A REFUSED EDIT IS SAID HERE, where the member made it.
                if state.hasStatus, state.status.refused, !state.status.sentence.isEmpty {
                    Text(state.status.sentence).kitType(.meta).foregroundStyle(StateColor.red.text)
                }

                // THE CAPTION, ITS OWN CARD.
                VStack(alignment: .leading, spacing: 2) {
                    Text(words.captionLabel).kitType(.meta).foregroundStyle(Surface.meta)
                    TextField(words.captionPlaceholder, text: $caption)
                        .kitType(.row)
                        .foregroundStyle(Surface.ink)
                        .focused($captionFocused)
                        .submitLabel(.done)
                        .onSubmit(commitCaption)
                        .accessibilityLabel(words.captionLabel)
                        // COMMITTED WHEN THE FIELD IS LEFT: the typed text stays
                        // exactly where it is if the vault says no.
                        .onChange(of: captionFocused) { _, focused in
                            if !focused { commitCaption() }
                        }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Surface.card, in: RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))

                // WHEN AND WITH WHAT, one card of rows.
                if !photo.facts.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(photo.facts.enumerated()), id: \.offset) { at, fact in
                            HStack(alignment: .top, spacing: 12) {
                                CentraidIconView(iconKey: fact.iconKey, tint: AppAccent("photos").text, size: 16)
                                    .padding(.top, 3)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(fact.label).kitType(.meta).foregroundStyle(Surface.meta)
                                    Text(fact.text).kitType(.row).foregroundStyle(Surface.ink)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(14)
                            .accessibilityElement(children: .combine)
                            if at < photo.facts.count - 1 {
                                Rectangle().fill(Surface.line).frame(height: CentraidGeometry.hairline).padding(.leading, 14)
                            }
                        }
                    }
                    .background(Surface.card, in: RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
                }

                // WHO IS IN IT, by hand: a section of its own (#1173).
                if photo.hasPeople {
                    LinkSectionView(section: photo.people, send: { link in send(.people(link)) }, open: open, padded: false)
                }

                // PLACE AND LABELS, one card.
                VStack(alignment: .leading, spacing: 0) {
                    place(words).padding(14)
                    Rectangle().fill(Surface.line).frame(height: CentraidGeometry.hairline).padding(.leading, 14)
                    labels(words).padding(14)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Surface.card, in: RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))

                // WHERE THE BYTES ARE, in a sentence that says what fetching costs.
                Text(photo.whereabouts)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                if !photo.trashLine.isEmpty {
                    Text(photo.trashLine).kitType(.meta).foregroundStyle(Surface.meta)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 14)
            // EVERY RECORD KEEPS ITS EARLIER VALUES (#1185): the foot of the details.
            EarlierEntryRow(entry: photo.hasEarlier ? photo.earlier : nil, open: open)
            OriginLineView(line: photo.hasOrigin ? photo.origin : nil)
        }
        // THE CARDS' NAME is what a screen reader says on entering them.
        .accessibilityElement(children: .contain)
        .accessibilityLabel(words.infoTitle)
        .appAccent("photos")
        .onAppear(perform: resetCaption)
        .onChange(of: state.photoID) { _, _ in resetCaption() }
        .onDisappear { if captionFocused { commitCaption() } }
    }

    private func resetCaption() {
        guard captionFor != state.photoID else { return }
        captionFor = state.photoID
        caption = photo.caption
        tag = ""
    }

    private func commitCaption() {
        send(.caption(.with { $0.caption = caption }))
    }

    private func place(_ words: Centraid_Core_V1_PhotosLightboxWords) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            heading(words.placeTitle, icon: "MapPin")
            Text(photo.placePhrase).centraidType("body")
            HStack(spacing: 16) {
                KitLink(label: photo.hasPlace_p ? words.change : words.addPlace) {
                    send(.sheet(.with { $0.sheet = .place }))
                }
                if photo.hasPlace_p {
                    KitLink(label: words.remove) { send(.placeChosen(.with { $0.placeID = "" })) }
                }
                if photo.canCopyLocation {
                    KitLink(label: words.copyLocation) { send(.copyLocation(.init())) }
                }
            }
        }
    }

    private func labels(_ words: Centraid_Core_V1_PhotosLightboxWords) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            heading(words.labelsTitle, icon: "Tag")
            if !photo.labelsLine.isEmpty {
                Text(photo.labelsLine)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            ForEach(photo.labels, id: \.tagID) { chip in
                HStack(spacing: 4) {
                    Text(chip.label).centraidType("small")
                    Button {
                        send(.tagRemoved(.with { $0.tagID = chip.tagID }))
                    } label: {
                        CentraidIconView(iconKey: "X", tint: Theme.color("textSoft", scheme), size: 14)
                            .frame(width: 34, height: 34)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(chip.removeLabel)
                }
                .padding(.leading, 10)
                .background(Surface.fill, in: Capsule())
            }
            TextField(words.addLabelPlaceholder, text: $tag)
                .centraidType("body")
                .submitLabel(.done)
                .accessibilityLabel(words.addLabelPlaceholder)
                .onSubmit {
                    let label = tag.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !label.isEmpty else { return }
                    send(.tagAdded(.with { $0.label = label }))
                    tag = ""
                }
        }
    }

    /// ONE HEADING STYLE for every section of the sheet: the mark, then the word.
    private func heading(_ text: String, icon: String) -> some View {
        HStack(spacing: 6) {
            CentraidIconView(iconKey: icon, tint: AppAccent("photos").text, size: 14)
            Text(text)
                .kitType(.meta)
                .foregroundStyle(Surface.meta)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - The facade the stage reads

/// WHAT THE STAGE AND THE STRIP READ OFF THE STATE: the paths they draw, by the
/// rule the state's own fields give. It decides nothing a person sees.
struct PhotosLightboxModel {
    let state: Centraid_Core_V1_PhotosLightboxState

    var photo: Centraid_Core_V1_PhotosLightboxPhoto? {
        state.hasPhoto ? state.photo : nil
    }

    var photoID: String { state.photoID }
    var words: Centraid_Core_V1_PhotosLightboxWords { state.words }
    var slideshow: Bool { state.slideshow }
    var chromeVisible: Bool { state.chromeVisible }

    /// The strip's window, in the shelf's order: what a swipe can reach.
    var neighbours: [String] { state.film.map(\.photoID) }

    var isVideo: Bool { photo?.tile.kind == .video }
    var originalMediaType: String { photo?.originalMediaType ?? "" }

    var originalPath: String? {
        guard let photo, photo.hasOriginalPath, !photo.originalPath.isEmpty else { return nil }
        return photo.originalPath
    }

    var drawableOriginal: String? {
        guard let photo, !isVideo, photo.originalEmbeddable else { return nil }
        return originalPath
    }

    var videoPath: String? {
        guard let photo, isVideo, photo.originalEmbeddable else { return nil }
        return originalPath
    }

    var livePath: String? {
        guard let photo, photo.hasLivePath, !photo.livePath.isEmpty else { return nil }
        return photo.livePath
    }

    var mediaKey: String { "\(videoPath ?? "")|\(livePath ?? "")" }

    /// What the stage draws for this photograph, or nil when it has nothing.
    var drawablePath: String? {
        guard let photo else { return nil }
        if let drawableOriginal { return drawableOriginal }
        if photo.tile.hasThumbnailPath, !photo.tile.thumbnailPath.isEmpty { return photo.tile.thumbnailPath }
        return nil
    }

    /// A neighbour's strip frame, when the strip has read it.
    func framePath(_ identifier: String) -> String? {
        guard let frame = state.film.first(where: { $0.photoID == identifier }),
              frame.hasTile, frame.tile.hasThumbnailPath, !frame.tile.thumbnailPath.isEmpty
        else { return nil }
        return frame.tile.thumbnailPath
    }

    func thumbnailPath(for identifier: String) -> String? {
        if let photo, photo.tile.photoID == identifier, photo.tile.hasThumbnailPath,
           !photo.tile.thumbnailPath.isEmpty {
            return photo.tile.thumbnailPath
        }
        return framePath(identifier)
    }

    /// The spoken name of the stage.
    var stageLabel: String { photo?.spoken ?? "" }
}


/// A floating control over the stage: Liquid Glass on iOS 26, a solid plate before it and under
/// Reduce Transparency or Increase Contrast. Only floating glass casts a shadow.
private struct PhotosStageGlass<S: Shape>: ViewModifier {
    let shape: S
    let solid: Color

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), !reduceTransparency, contrast != .increased {
            content.glassEffect(.regular, in: shape)
        } else {
            content.background(solid, in: shape)
        }
    }
}


/// THE PHOTOGRAPH'S BAND HEIGHT: the whole page while the details are closed, a little over a third
/// of it while they are open.
private struct PhotosBandHeight: ViewModifier {
    let shrunk: Bool

    func body(content: Content) -> some View {
        if shrunk {
            content.containerRelativeFrame(.vertical) { height, _ in height * 0.36 }
        } else {
            content.frame(maxHeight: .infinity)
        }
    }
}
