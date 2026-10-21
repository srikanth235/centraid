import Foundation

import CentraidShared

/// THE PHOTOS SCREENS' IDS, each its machine's own `SCREEN_ID`. Photos is not
/// an `AppScreens` (its bridges live on `ShellModel` and its routes are cases
/// of `ShellModel.Route`), so `ShellModel.send(screen:event:)` and the views
/// that forward an event name a screen through here and never by a string.
enum PhotosScreens {
    static let grid = PhotosGridMachine.shared.SCREEN_ID
    static let shelf = PhotoShelfMachine.shared.SCREEN_ID
    static let lightbox = PhotoLightboxMachine.shared.SCREEN_ID
    static let picker = PhotoPickerMachine.shared.SCREEN_ID
    static let collections = PhotosCollectionsMachine.shared.SCREEN_ID
    static let search = PhotosSearchMachine.shared.SCREEN_ID
    static let places = PlacesMachine.shared.SCREEN_ID
    static let duplicates = DuplicatesMachine.shared.SCREEN_ID
    static let duplicateReview = DuplicateReviewMachine.shared.SCREEN_ID
    static let editor = PhotoEditorMachine.shared.SCREEN_ID
}
