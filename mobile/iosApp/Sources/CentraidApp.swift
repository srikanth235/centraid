import SwiftUI

/// The iOS composition root (#1020, D-1020-E1).
///
/// **The views own nothing.** Every one of them takes a finished state message
/// and forwards events; the state machines are in `CentraidShared`, and this
/// file is the only one that knows the stack.
///
/// ONE ROOT STACK, NO TAB BAR — apps are covers over Home. That is a product
/// ruling, not a SwiftUI preference.
// THE ENTRY POINT IS THE iOS APP'S, NOT THE TEST HOST'S (#1020).
//
// `Sources` is a LIBRARY target, so an unguarded `@main` emits `_main` into it
// and `swift test` — reason 3 in `Package.swift`'s header — fails linking the
// XCTest runner with a duplicate symbol. The app entry belongs to the platform
// that has an app; the macOS host build is only ever the fixture test's.
#if os(iOS)
@main
struct CentraidApp: App {
    @StateObject private var shell = ShellModel()
    /// WHAT THE SCENE PHASE STILL DECIDES (#1029 §1).
    ///
    /// It used to open and close the TAIL: `active` connected to the gateway's
    /// log stream and held it, `inactive` and `background` closed it. There is
    /// no gateway and no stream — the vault is on this phone and it is already
    /// current — so arriving and leaving are no longer sync occasions.
    ///
    /// What is left is the SWITCHER MASK, which was never about the network:
    /// a phone in the app switcher must not show a member's rows in a snapshot
    /// the OS keeps (`docs/mobile-offline.md:253`).
    @Environment(\.scenePhase) private var scenePhase

    /// REGISTER THE BACKGROUND HANDLERS BEFORE ANYTHING SUBMITS ONE (#1029 W18-1).
    ///
    /// iOS requires every `BGTaskScheduler` launch handler to be installed
    /// before the app finishes launching, and raises
    /// `NSInternalInconsistencyException` — which **terminates the app**, rather
    /// than failing the task — for a submit whose identifier has no handler.
    /// `ShellModel()` is what eventually submits, and an `init` body runs before
    /// any of this type's property-wrapper storage is read, so this is the one
    /// place in the app that is unambiguously launch.
    init() {
        BackgroundPasses.register()
    }

    var body: some Scene {
        WindowGroup {
            NavigationStack(path: $shell.path) {
                HomeView(shell: shell)
                    .navigationDestination(for: ShellModel.Route.self) { route in
                        Group {
                            switch route {
                            case .tally:
                                TallyListView(shell: shell)
                            case .photos:
                                PhotosGridView(shell: shell)
                            case let .note(identifier):
                                NotesEditorView(shell: shell, noteIdentifier: identifier)

                            // THE PHOTOS MINIAPP'S OTHER NINE SCREENS.
                            //
                            // Every one takes BYTES and closures, never this
                            // model: a view that held the shell would be a
                            // view that could reach past its own screen, and
                            // the whole execution model is that a view renders
                            // a finished state and forwards events.
                            case let .photoShelf(shelf):
                                PhotoShelfView(
                                    data: shell.photoShelfState,
                                    shelf: (try? Centraid_Screen_V1_PhotoShelf(
                                        serializedBytes: shelf
                                    )) ?? .init(),
                                    copy: shell.photoShelfCopy,
                                    send: { shell.send(screen: "photos.shelf", event: $0) },
                                    onOpenAsset: { identifier, neighbours in
                                        // AN ALBUM'S LIGHTBOX KNOWS ITS ALBUM,
                                        // for "Make key photo".
                                        let album = (try? Centraid_Screen_V1_PhotoShelf(
                                            serializedBytes: shelf
                                        ))?.album.collectionID ?? ""
                                        shell.path.append(
                                            .photoLightbox(identifier, neighbours, album: album)
                                        )
                                    },
                                    onAddPhotographs: { identifier, name in
                                        shell.path.append(.photoPicker(identifier, name))
                                    },
                                    onExport: { identifiers, kind in
                                        shell.exportShelf(identifiers, as: kind)
                                    }
                                )

                            case let .photoLightbox(identifier, _, _):
                                PhotoLightboxView(
                                    data: shell.photoLightboxState,
                                    send: { shell.send(screen: "photos.lightbox", event: $0) }
                                )
                                // THE NEIGHBOURS RIDE THE ROUTE and reach the
                                // machine through `shell.opened(route)` below,
                                // so a swipe needs no read. `.id` is what makes
                                // SwiftUI rebuild when a member swipes from one
                                // photograph to the next.
                                .id(identifier)
                                // EDIT PUSHES THE EDITOR, with the neighbours,
                                // so a save can come back to the same shelf.
                                .environment(\.openPhotoEditor) { assetIdentifier, neighbours in
                                    shell.path.append(.photoEditor(assetIdentifier, neighbours))
                                }

                            case let .photoPicker(identifier, name):
                                PhotoPickerView(
                                    data: shell.photoPickerState,
                                    collectionIdentifier: identifier,
                                    collectionName: name,
                                    // EMPTY, AND NOT A GAP: the picker reads
                                    // the album's whole membership itself on
                                    // open (`PhotoPickerMachine.MEMBERS_READ_ID`)
                                    // — no caller holds more than one page of it.
                                    alreadyInAlbum: [],
                                    send: { shell.send(screen: "photos.picker", event: $0) },
                                    onFinished: { shell.path.removeLast() }
                                )

                            case .places:
                                PlacesView(
                                    data: shell.placesState,
                                    send: { shell.send(screen: "photos.places", event: $0) },
                                    onOpenPlace: { identifier, name in
                                        shell.path.append(.photoShelf(shell.placeShelf(
                                            identifier: identifier,
                                            name: name
                                        )))
                                    },
                                    onOpenShelf: { shell.path.append(.photoShelf($0)) }
                                )

                            case .photosPeople:
                                PhotosPeopleView(
                                    data: shell.photosPeopleState,
                                    onEvent: { shell.send(screen: "photos.people", event: $0) },
                                    onOpenPerson: { identifier, name in
                                        shell.path.append(.photoShelf(shell.personShelf(
                                            identifier: identifier,
                                            name: name
                                        )))
                                    },
                                    onOpenFaceReview: { shell.path.append(.photoFaceReview) }
                                )

                            case .photoFaceReview:
                                FaceReviewView(
                                    data: shell.faceReviewState,
                                    onEvent: { shell.send(screen: "photos.faces", event: $0) }
                                )

                            case .photosMemories:
                                PhotosMemoriesView(
                                    data: shell.photosMemoriesState,
                                    send: { shell.send(screen: "photos.memories", event: $0) },
                                    onOpenMemory: { identifier, title in
                                        shell.path.append(.photoShelf(shell.memoryShelf(
                                            identifier: identifier,
                                            title: title
                                        )))
                                    }
                                )

                            case .photoDuplicates:
                                DuplicatesView(
                                    data: shell.duplicatesState,
                                    send: { shell.send(screen: "photos.duplicates", event: $0) },
                                    onOpenCluster: { identifier in
                                        shell.path.append(.photoDuplicateReview(identifier))
                                    }
                                )

                            case let .photoDuplicateReview(identifier):
                                DuplicateReviewView(
                                    data: shell.duplicateReviewState,
                                    send: { shell.send(screen: "photos.duplicate", event: $0) }
                                )
                                .id(identifier)

                            // THE EDITOR (#1029). Cancel pops back onto the
                            // lightbox it came from; a save replaces that
                            // lightbox with one on the NEW photograph.
                            case let .photoEditor(identifier, neighbours):
                                PhotoEditorView(
                                    data: shell.photoEditorState,
                                    send: { shell.send(screen: "photos.editor", event: $0) },
                                    onClose: { shell.path.removeLast() },
                                    onSaved: { saved in
                                        shell.photoEditSaved(saved, neighbours: neighbours)
                                    }
                                )
                                .id(identifier)
                            }
                        }
                        // A SCREEN READS BECAUSE IT WAS OPENED. The machine
                        // emits its first `ReadPage` from `Opened` and from
                        // nothing else, so a cover that was pushed and never
                        // told would sit loading for ever (#1025 S5, lane L5).
                        // `.task` and not `.onAppear`: a pop back onto this
                        // cover re-runs it, and a screen a member returned to
                        // should re-read rather than show the page it had when
                        // they left.
                        .task { shell.opened(route) }
                    }
            }
            // THE SWITCHER MASK. Leaving the foreground paints an opaque mask
            // (`docs/mobile-offline.md:253`) — not cosmetic: it is the visible
            // half of a lock that has already happened.
            .overlay { if shell.masked { Color.black.ignoresSafeArea() } }
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                // `inactive` IS ALREADY LEAVING: a phone in the app switcher is
                // not a phone the member is looking at, and the snapshot the OS
                // takes is of whatever is on screen at that moment.
                case .active:
                    shell.unmask()
                    // AND DRAIN. The amendment's foreground half (#1029 W18-6):
                    // the phone backs up while the member is in the app, not
                    // only in the windows iOS grants. `ShelfDrain` refuses a
                    // second pass while one runs, so an `inactive` → `active`
                    // flicker costs nothing.
                    shell.becameActive()
                case .inactive, .background:
                    shell.mask()
                @unknown default:
                    shell.mask()
                }
            }
        }
    }
}

#endif

// `HomeView` lives in `HomeView.swift`: Home is the graded springboard
// (#1020, wave A), not a list of links, and it is too large to sit in the
// composition root.
