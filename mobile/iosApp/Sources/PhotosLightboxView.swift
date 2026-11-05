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
            // THE STAGE IS THE DARKEST SURFACE AND IT IS NOT THE PAGE.
            Theme.color("stage", scheme).ignoresSafeArea()
            switch state.content {
            case .loading?, nil:
                // BEFORE THE READ LANDS THE STAGE STILL DRAWS what it has — the
                // strip frame of the photograph a member swiped to — and a ring
                // only over a stage with nothing at all.
                stage(model).ignoresSafeArea()
                if model.framePath(state.photoID) == nil {
                    Text(state.words.opening)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("onStageSoft", scheme))
                }
            case let .denied(denied)?:
                DeniedGate(denied)
            case let .failure(failure)?:
                ScreenFailureView(sentence: failure.sentence, remedy: failure.remedy)
                    .padding(CentraidGeometry.pageMargin)
            case let .photo(photo)?:
                if state.detailsVisible {
                    details(photo, model: model)
                } else {
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
        // THE STAGE ROOM TAKES NO HEADER (product-intuition screen contracts): its way out is the close
        // chip and the swipe down, both the same act.
        .toolbar(.hidden, for: .navigationBar)
        .sheet(item: sheetBinding) { item in
            sheet(item.kind)
        }
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

    private func stage(_ model: PhotosLightboxModel) -> some View {
        PhotosLightboxStage(
            state: model,
            player: media.video,
            live: media.live,
            send: send,
            onClose: onClose
        )
    }

    /// Info expands on the photograph's page. Opening a place, album or share
    /// choice may present a sheet; photo details never move into the editor.
    private func details(_ photo: Centraid_Core_V1_PhotosLightboxPhoto, model: PhotosLightboxModel) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                HStack {
                    KitIconKey(iconKey: "X", label: state.words.close, tint: "text", identifier: "photos.lightbox.close", action: onClose)
                    Spacer()
                    KitIconKey(iconKey: "more", label: state.words.more, tint: "text", identifier: "photos.lightbox.more") { send(sheetEvent(.more)) }
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.vertical, 8)
                stage(model)
                    .frame(height: 268)
                    .clipped()
                    .overlay {
                        if model.drawablePath == nil {
                            Text(photo.stageLabel).centraidType("body")
                                .foregroundStyle(Theme.color("onStage", scheme))
                        }
                    }
                if let video = media.video {
                    LightboxTransport(player: video, words: state.words)
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .background(Theme.color("stage", scheme))
                }
                if let live = media.live { LiveChip(live: live, words: state.words) }
                if photo.offersFetch {
                    KitLink(label: state.words.loadOriginal) { send(.fetchOriginal(.init())) }
                        .padding(.top, 8)
                }
                PhotosLightboxInfoSheet(state: state, photo: photo, send: send)
                    .accessibilityIdentifier("photos.lightbox.details")
            }
        }
        .background(Theme.color("bg", scheme))
        .safeAreaInset(edge: .bottom) {
            toolbar(onPage: true)
                .padding(.vertical, 8)
                .bandGround(RoundedRectangle(cornerRadius: Theme.radius("lg", scheme)), solid: "bgElev")
                .padding(.horizontal, 8)
                .padding(.bottom, 8)
        }
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
                if state.slideshow {
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
                } else {
                    chip(icon: "more", label: state.words.more) { send(sheetEvent(.more)) }
                }
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
                Text(state.status.sentence)
                    .centraidType("small")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Theme.color("onStage", scheme))
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

    private func pagerButton(icon: String, label: String, target: String, onPage: Bool = false) -> some View {
        Button {
            if !target.isEmpty { send(.moved(.with { $0.photoID = target })) }
        } label: {
            CentraidIconView(
                iconKey: icon,
                tint: Theme.color(target.isEmpty ? (onPage ? "textFaint" : "onStageSoft") : (onPage ? "text" : "onStage"), scheme),
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
    private func toolbar(onPage: Bool = false) -> some View {
        let reasons = Array(Set(state.toolbar.filter { !$0.enabled && !$0.why.isEmpty }.map(\.why))).sorted()
        var trashed = false
        if case let .photo(photo)? = state.content { trashed = photo.trashed }
        // THE POINTER EQUIVALENT FOR SWIPE: nothing here is reachable by gesture alone.
        // The arrows are the ends of the one row, so they line up with the verbs between
        // them; the ids are Rust's `previous_id` and `next_id`, empty at either end.
        let paged = !state.previousID.isEmpty || !state.nextID.isEmpty
        return VStack(spacing: 4) {
            HStack(spacing: 0) {
                if paged {
                    pagerButton(icon: "ChevronLeft", label: state.words.previous, target: state.previousID, onPage: onPage)
                }
                ForEach(state.toolbar, id: \.kind.rawValue) { verb in
                    toolbarKey(verb, labelled: trashed, onPage: onPage)
                        .frame(maxWidth: .infinity)
                }
                if paged {
                    pagerButton(icon: "ChevronRight", label: state.words.next, target: state.nextID, onPage: onPage)
                }
            }
            ForEach(reasons, id: \.self) { reason in
                Text(reason)
                    .centraidType("small")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Theme.color(onPage ? "textFaint" : "onStageSoft", scheme))
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
    }

    /// ONE VERB OF THE BAR. A toggle that is ON is drawn solid (a filled star) and is
    /// announced as selected; over a trashed photograph the verbs carry their words, because
    /// a restore and a delete-forever side by side are two marks a member must tell apart.
    private func toolbarKey(_ verb: Centraid_Core_V1_PhotosLightboxVerb, labelled: Bool = false, onPage: Bool = false) -> some View {
        Button {
            guard verb.enabled else { return }
            // Edit is a page: the shell pushes the route Rust built.
            if verb.hasRoute { open(verb.route) } else { send(verbEvent(verb)) }
        } label: {
            let normal = onPage ? "text" : "onStage"
            let selected = onPage ? "photosText" : "photosOnStage"
            let disabled = onPage ? "textFaint" : "onStageSoft"
            let ink = Theme.color(verb.enabled ? (verb.destructive ? "net" : (verb.on ? selected : normal)) : disabled, scheme)
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
        case .more: return LightboxSheetItem(kind: .more)
        case .place: return LightboxSheetItem(kind: .place)
        default: return nil
        }
    }

    @ViewBuilder
    private func sheet(_ kind: LightboxSheetItem.Kind) -> some View {
        switch kind {
        case .info:
            if case let .photo(photo)? = state.content {
                PhotosLightboxInfoSheet(state: state, photo: photo, send: send)
                    .modifier(SheetPresentation(detents: [.fraction(0.64), .large]))
            }
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
            .presentationDetents([.medium])
        case .more:
            OptionSheet(title: state.words.more) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(state.menu, id: \.kind.rawValue) { verb in
                            moreRow(verb)
                        }
                    }
                }
            }
            .presentationDetents([.medium, .large])
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

    /// ONE MENU ROW: a refusal rides as the row's detail under its label rather
    /// than becoming a second, shorter phrasing of the same truth.
    private func moreRow(_ verb: Centraid_Core_V1_PhotosLightboxVerb) -> some View {
        Button {
            guard verb.enabled else { return }
            send(verbEvent(verb))
        } label: {
            HStack(spacing: 12) {
                let ink = Theme.color(!verb.enabled ? "textDisabled" : (verb.destructive ? "net" : "text"), scheme)
                CentraidIconView(iconKey: verb.iconKey, tint: ink, size: 20)
                Text(verb.enabled ? verb.label : "\(verb.label) — \(verb.why)")
                    .centraidType("control")
                    .foregroundStyle(ink)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .disabled(!verb.enabled)
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
        case info, share, more, place, album, confirm
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

// MARK: - Details beneath the photograph

/// Everything the vault knows about this photograph, and the four
/// things a member may change about it: the caption, the labels, the place, and a
/// copy of where it was taken. No destructive control here, ever: Trash lives on
/// the bar alone. A field the record lacks is omitted, never invented.
private struct PhotosLightboxInfoSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize
    let state: Centraid_Core_V1_PhotosLightboxState
    let photo: Centraid_Core_V1_PhotosLightboxPhoto
    let send: (PhotosLightboxSend) -> Void

    @State private var caption = ""
    @State private var captionFor = ""
    @State private var tag = ""
    @FocusState private var captionFocused: Bool

    var body: some View {
        let words = state.words
        VStack(alignment: .leading, spacing: 12) {
                Text(words.infoTitle).centraidType("title").padding(.top, 8)

                // A REFUSED EDIT IS SAID HERE, where the member made it.
                if state.hasStatus, state.status.refused, !state.status.sentence.isEmpty {
                    Text(state.status.sentence).centraidType("small").foregroundStyle(Theme.color("net", scheme))
                }

                VStack(alignment: .leading, spacing: 6) {
                    heading(words.captionLabel, icon: "FileEdit")
                    TextField(words.captionPlaceholder, text: $caption)
                    .centraidType("body")
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
                .background(Theme.color("bgElev", scheme), in: RoundedRectangle(cornerRadius: Theme.radius("lg", scheme)))

                ForEach(photo.facts, id: \.label) { fact in
                    VStack(alignment: .leading, spacing: 2) {
                        heading(fact.label, icon: fact.iconKey)
                        Text(fact.text).centraidType("body")
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.color("bgElev", scheme), in: RoundedRectangle(cornerRadius: Theme.radius("lg", scheme)))
                }

                place(words)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.color("bgElev", scheme), in: RoundedRectangle(cornerRadius: Theme.radius("lg", scheme)))
                labels(words)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.color("bgElev", scheme), in: RoundedRectangle(cornerRadius: Theme.radius("lg", scheme)))

                // WHERE THE BYTES ARE, in a sentence that says what fetching costs.
                Text(photo.whereabouts)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                if !photo.trashLine.isEmpty {
                    Text(photo.trashLine).centraidType("small").foregroundStyle(Theme.color("textSoft", scheme))
                }
                if state.hasStatus, !state.status.refused, !state.status.sentence.isEmpty {
                    Text(state.status.sentence).centraidType("small").foregroundStyle(Theme.color("textSoft", scheme))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .foregroundStyle(Theme.color("text", scheme))
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, CentraidGeometry.pageMargin)
            // The final line clears the floating toolbar.
            .padding(.bottom, 16)
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
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(spacing: 16))
        return VStack(alignment: .leading, spacing: 4) {
            heading(words.placeTitle, icon: "MapPin")
            Text(photo.placePhrase).centraidType("body")
            layout {
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
                .background(
                    Theme.color("bgSunken", scheme),
                    in: RoundedRectangle(cornerRadius: Theme.radius("md", scheme), style: .continuous)
                )
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
            CentraidIconView(iconKey: icon, tint: Theme.color("textSoft", scheme), size: 14)
            Text(text)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
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
        if case let .photo(value)? = state.content { return value }
        return nil
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
