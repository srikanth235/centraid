import Foundation

#if canImport(CentraidShared)
import CentraidShared
#endif

/// PHOTOS' WORDS — `copy/photos.json` through `PhotosCopy`, the one table both shells read.
/// A view spells nothing itself; `{name}` marks a hole `fill` closes. Empty without the shared
/// framework, as `ShellWords` is.
enum PhotosWords {
    #if canImport(CentraidShared)
    static var photograph: String { PhotosCopy.shared.PHOTOGRAPH }
    static var photosAddLabel: String { PhotosCopy.shared.PHOTOS_ADD_LABEL }
    static var photosAddPhotos: String { PhotosCopy.shared.PHOTOS_ADD_PHOTOS }
    static var photosAddPlace: String { PhotosCopy.shared.PHOTOS_ADD_PLACE }
    static var photosAddToAlbum: String { PhotosCopy.shared.PHOTOS_ADD_TO_ALBUM }
    static var photosAdjustLocation: String { PhotosCopy.shared.PHOTOS_ADJUST_LOCATION }
    static var photosAlbumChoiceNew: String { PhotosCopy.shared.PHOTOS_ALBUM_CHOICE_NEW }
    static var photosAlbumChoiceNone: String { PhotosCopy.shared.PHOTOS_ALBUM_CHOICE_NONE }
    static var photosAlbumName: String { PhotosCopy.shared.PHOTOS_ALBUM_NAME }
    static var photosAlbumOptions: String { PhotosCopy.shared.PHOTOS_ALBUM_OPTIONS }
    static var photosAlbumRefers: String { PhotosCopy.shared.PHOTOS_ALBUM_REFERS }
    static var photosAlreadyInAlbum: String { PhotosCopy.shared.PHOTOS_ALREADY_IN_ALBUM }
    static var photosAlreadyYours: String { PhotosCopy.shared.PHOTOS_ALREADY_YOURS }
    static var photosArchive: String { PhotosCopy.shared.PHOTOS_ARCHIVE }
    static var photosArchiveEmpty: String { PhotosCopy.shared.PHOTOS_ARCHIVE_EMPTY }
    static var photosCameraRoll: String { PhotosCopy.shared.PHOTOS_CAMERA_ROLL }
    static var photosCaptionPlaceholder: String { PhotosCopy.shared.PHOTOS_CAPTION_PLACEHOLDER }
    static var photosCellNotDownloaded: String { PhotosCopy.shared.PHOTOS_CELL_NOT_DOWNLOADED }
    static var photosCellPreviewGone: String { PhotosCopy.shared.PHOTOS_CELL_PREVIEW_GONE }
    static var photosChosen: String { PhotosCopy.shared.PHOTOS_CHOSEN }
    static var photosClearPlaceDetail: String { PhotosCopy.shared.PHOTOS_CLEAR_PLACE_DETAIL }
    static var photosCollectionsNoAlbums: String { PhotosCopy.shared.PHOTOS_COLLECTIONS_NO_ALBUMS }
    static var photosCollectionsNoAlbumsCaption: String { PhotosCopy.shared.PHOTOS_COLLECTIONS_NO_ALBUMS_CAPTION }
    static var photosCollectionsNoMemories: String { PhotosCopy.shared.PHOTOS_COLLECTIONS_NO_MEMORIES }
    static var photosCollectionsNoMemoriesCaption: String { PhotosCopy.shared.PHOTOS_COLLECTIONS_NO_MEMORIES_CAPTION }
    static var photosCollectionsPeopleCaption: String { PhotosCopy.shared.PHOTOS_COLLECTIONS_PEOPLE_CAPTION }
    static var photosCopyExactLocation: String { PhotosCopy.shared.PHOTOS_COPY_EXACT_LOCATION }
    static var photosCropArea: String { PhotosCopy.shared.PHOTOS_CROP_AREA }
    static var photosCropDown: String { PhotosCopy.shared.PHOTOS_CROP_DOWN }
    static var photosCropHint: String { PhotosCopy.shared.PHOTOS_CROP_HINT }
    static var photosCropLarger: String { PhotosCopy.shared.PHOTOS_CROP_LARGER }
    static var photosCropLeft: String { PhotosCopy.shared.PHOTOS_CROP_LEFT }
    static var photosCropRight: String { PhotosCopy.shared.PHOTOS_CROP_RIGHT }
    static var photosCropSmaller: String { PhotosCopy.shared.PHOTOS_CROP_SMALLER }
    static var photosCropUp: String { PhotosCopy.shared.PHOTOS_CROP_UP }
    static var photosDeleteAlbum: String { PhotosCopy.shared.PHOTOS_DELETE_ALBUM }
    static var photosDeleteAlbumBody: String { PhotosCopy.shared.PHOTOS_DELETE_ALBUM_BODY }
    static var photosDeleteAlbumTitle: String { PhotosCopy.shared.PHOTOS_DELETE_ALBUM_TITLE }
    static var photosDeleteForever: String { PhotosCopy.shared.PHOTOS_DELETE_FOREVER }
    static var photosDeleteForeverBody: String { PhotosCopy.shared.PHOTOS_DELETE_FOREVER_BODY }
    static var photosDeleteForeverConfirm: String { PhotosCopy.shared.PHOTOS_DELETE_FOREVER_CONFIRM }
    static var photosDeleteForeverMany: String { PhotosCopy.shared.PHOTOS_DELETE_FOREVER_MANY }
    static var photosDeleteForeverOne: String { PhotosCopy.shared.PHOTOS_DELETE_FOREVER_ONE }
    static var photosDownloadOriginal: String { PhotosCopy.shared.PHOTOS_DOWNLOAD_ORIGINAL }
    static var photosDuplicatesLooking: String { PhotosCopy.shared.PHOTOS_DUPLICATES_LOOKING }
    static var photosDuplicatesLookingCaption: String { PhotosCopy.shared.PHOTOS_DUPLICATES_LOOKING_CAPTION }
    static var photosDuplicatesNoneCaption: String { PhotosCopy.shared.PHOTOS_DUPLICATES_NONE_CAPTION }
    static var photosDuplicatesPickOne: String { PhotosCopy.shared.PHOTOS_DUPLICATES_PICK_ONE }
    static var photosDuplicatesSetMany: String { PhotosCopy.shared.PHOTOS_DUPLICATES_SET_MANY }
    static var photosDuplicatesSetOne: String { PhotosCopy.shared.PHOTOS_DUPLICATES_SET_ONE }
    static var photosDuplicatesStillLooking: String { PhotosCopy.shared.PHOTOS_DUPLICATES_STILL_LOOKING }
    static var photosEditorTitle: String { PhotosCopy.shared.PHOTOS_EDITOR_TITLE }
    static var photosEditCannotDraw: String { PhotosCopy.shared.PHOTOS_EDIT_CANNOT_DRAW }
    static var photosEditCannotOpen: String { PhotosCopy.shared.PHOTOS_EDIT_CANNOT_OPEN }
    static var photosEditDiscardQuestion: String { PhotosCopy.shared.PHOTOS_EDIT_DISCARD_QUESTION }
    static var photosEditFromUndated: String { PhotosCopy.shared.PHOTOS_EDIT_FROM_UNDATED }
    static var photosEditKeepEditing: String { PhotosCopy.shared.PHOTOS_EDIT_KEEP_EDITING }
    static var photosEditNotAPhoto: String { PhotosCopy.shared.PHOTOS_EDIT_NOT_A_PHOTO }
    static var photosEditNotLoaded: String { PhotosCopy.shared.PHOTOS_EDIT_NOT_LOADED }
    static var photosEditSaving: String { PhotosCopy.shared.PHOTOS_EDIT_SAVING }
    static var photosEmptyDuplicates: String { PhotosCopy.shared.PHOTOS_EMPTY_DUPLICATES }
    static var photosEmptyFavorites: String { PhotosCopy.shared.PHOTOS_EMPTY_FAVORITES }
    static var photosEmptyTrash: String { PhotosCopy.shared.PHOTOS_EMPTY_TRASH }
    static var photosEmptyTrashBody: String { PhotosCopy.shared.PHOTOS_EMPTY_TRASH_BODY }
    static var photosEmptyTrashTitle: String { PhotosCopy.shared.PHOTOS_EMPTY_TRASH_TITLE }
    static var photosErrorEditNotSaved: String { PhotosCopy.shared.PHOTOS_ERROR_EDIT_NOT_SAVED }
    static var photosErrorExportFailed: String { PhotosCopy.shared.PHOTOS_ERROR_EXPORT_FAILED }
    static var photosErrorFreeUpPaused: String { PhotosCopy.shared.PHOTOS_ERROR_FREE_UP_PAUSED }
    static var photosErrorInCloud: String { PhotosCopy.shared.PHOTOS_ERROR_IN_CLOUD }
    static var photosErrorWriteNotSaved: String { PhotosCopy.shared.PHOTOS_ERROR_WRITE_NOT_SAVED }
    static var photosExportSaved: String { PhotosCopy.shared.PHOTOS_EXPORT_SAVED }
    static var photosFacesAFace: String { PhotosCopy.shared.PHOTOS_FACES_A_FACE }
    static var photosFacesKeepUnnamed: String { PhotosCopy.shared.PHOTOS_FACES_KEEP_UNNAMED }
    static var photosFacesNewName: String { PhotosCopy.shared.PHOTOS_FACES_NEW_NAME }
    static var photosFacesNone: String { PhotosCopy.shared.PHOTOS_FACES_NONE }
    static var photosFacesNoneCaption: String { PhotosCopy.shared.PHOTOS_FACES_NONE_CAPTION }
    static var photosFacesNotThis: String { PhotosCopy.shared.PHOTOS_FACES_NOT_THIS }
    static var photosFacesOffCaption: String { PhotosCopy.shared.PHOTOS_FACES_OFF_CAPTION }
    static var photosFacesSayWho: String { PhotosCopy.shared.PHOTOS_FACES_SAY_WHO }
    static var photosFacesSkipForNow: String { PhotosCopy.shared.PHOTOS_FACES_SKIP_FOR_NOW }
    static var photosFacesSomeoneElse: String { PhotosCopy.shared.PHOTOS_FACES_SOMEONE_ELSE }
    static var photosFacesWho: String { PhotosCopy.shared.PHOTOS_FACES_WHO }
    static var photosFavorite: String { PhotosCopy.shared.PHOTOS_FAVORITE }
    static var photosFileSizeUnreadable: String { PhotosCopy.shared.PHOTOS_FILE_SIZE_UNREADABLE }
    static var photosFreeUpTitle: String { PhotosCopy.shared.PHOTOS_FREE_UP_TITLE }
    static var photosGridEmpty: String { PhotosCopy.shared.PHOTOS_GRID_EMPTY }
    static var photosGridEmptyCaption: String { PhotosCopy.shared.PHOTOS_GRID_EMPTY_CAPTION }
    static var photosGridNoFavorites: String { PhotosCopy.shared.PHOTOS_GRID_NO_FAVORITES }
    static var photosGridNoFavoritesCaption: String { PhotosCopy.shared.PHOTOS_GRID_NO_FAVORITES_CAPTION }
    static var photosGridSelect: String { PhotosCopy.shared.PHOTOS_GRID_SELECT }
    static var photosGridSelectedMany: String { PhotosCopy.shared.PHOTOS_GRID_SELECTED_MANY }
    static var photosGridSelectedOne: String { PhotosCopy.shared.PHOTOS_GRID_SELECTED_ONE }
    static var photosGridTrashConfirm: String { PhotosCopy.shared.PHOTOS_GRID_TRASH_CONFIRM }
    static var photosImportAuto: String { PhotosCopy.shared.PHOTOS_IMPORT_AUTO }
    static var photosImportDone: String { PhotosCopy.shared.PHOTOS_IMPORT_DONE }
    static var photosImportDoneCount: String { PhotosCopy.shared.PHOTOS_IMPORT_DONE_COUNT }
    static var photosImportLooking: String { PhotosCopy.shared.PHOTOS_IMPORT_LOOKING }
    static var photosImportNow: String { PhotosCopy.shared.PHOTOS_IMPORT_NOW }
    static var photosImportOff: String { PhotosCopy.shared.PHOTOS_IMPORT_OFF }
    static var photosImportPausedDisk: String { PhotosCopy.shared.PHOTOS_IMPORT_PAUSED_DISK }
    static var photosImportProgress: String { PhotosCopy.shared.PHOTOS_IMPORT_PROGRESS }
    static var photosImportRunning: String { PhotosCopy.shared.PHOTOS_IMPORT_RUNNING }
    static var photosImportWaitCounts: String { PhotosCopy.shared.PHOTOS_IMPORT_WAIT_COUNTS }
    static var photosImportWaitPower: String { PhotosCopy.shared.PHOTOS_IMPORT_WAIT_POWER }
    static var photosImportWaitWifi: String { PhotosCopy.shared.PHOTOS_IMPORT_WAIT_WIFI }
    static var photosKeepIt: String { PhotosCopy.shared.PHOTOS_KEEP_IT }
    static var photosKeepOriginalsLabel: String { PhotosCopy.shared.PHOTOS_KEEP_ORIGINALS_LABEL }
    static var photosKeepOriginalsTitle: String { PhotosCopy.shared.PHOTOS_KEEP_ORIGINALS_TITLE }
    static var photosKeepThem: String { PhotosCopy.shared.PHOTOS_KEEP_THEM }
    static var photosLabelsNone: String { PhotosCopy.shared.PHOTOS_LABELS_NONE }
    static var photosLabelsUnreadable: String { PhotosCopy.shared.PHOTOS_LABELS_UNREADABLE }
    static var photosLibraryLoadingMore: String { PhotosCopy.shared.PHOTOS_LIBRARY_LOADING_MORE }
    static var photosLibraryUndatedNote: String { PhotosCopy.shared.PHOTOS_LIBRARY_UNDATED_NOTE }
    static var photosLoadOriginal: String { PhotosCopy.shared.PHOTOS_LOAD_ORIGINAL }
    static var photosLocationCopied: String { PhotosCopy.shared.PHOTOS_LOCATION_COPIED }
    static var photosMakeKey: String { PhotosCopy.shared.PHOTOS_MAKE_KEY }
    static var photosMemoriesEmpty: String { PhotosCopy.shared.PHOTOS_MEMORIES_EMPTY }
    static var photosMemoriesEmptyCaption: String { PhotosCopy.shared.PHOTOS_MEMORIES_EMPTY_CAPTION }
    static var photosMemoriesNotLooked: String { PhotosCopy.shared.PHOTOS_MEMORIES_NOT_LOOKED }
    static var photosMemoriesNotLookedCaption: String { PhotosCopy.shared.PHOTOS_MEMORIES_NOT_LOOKED_CAPTION }
    static var photosMemorySimilar: String { PhotosCopy.shared.PHOTOS_MEMORY_SIMILAR }
    static var photosMoreFoot: String { PhotosCopy.shared.PHOTOS_MORE_FOOT }
    static var photosMoreTitle: String { PhotosCopy.shared.PHOTOS_MORE_TITLE }
    static var photosNewAlbum: String { PhotosCopy.shared.PHOTOS_NEW_ALBUM }
    static var photosNext: String { PhotosCopy.shared.PHOTOS_NEXT }
    static var photosNothingOnPhone: String { PhotosCopy.shared.PHOTOS_NOTHING_ON_PHONE }
    static var photosNotInVault: String { PhotosCopy.shared.PHOTOS_NOT_IN_VAULT }
    static var photosNotOnPhone: String { PhotosCopy.shared.PHOTOS_NOT_ON_PHONE }
    static var photosNotOnPhoneShort: String { PhotosCopy.shared.PHOTOS_NOT_ON_PHONE_SHORT }
    static var photosNoPlaces: String { PhotosCopy.shared.PHOTOS_NO_PLACES }
    static var photosOpeningLibrary: String { PhotosCopy.shared.PHOTOS_OPENING_LIBRARY }
    static var photosOriginalDownloading: String { PhotosCopy.shared.PHOTOS_ORIGINAL_DOWNLOADING }
    static var photosOriginalDownloadingNow: String { PhotosCopy.shared.PHOTOS_ORIGINAL_DOWNLOADING_NOW }
    static var photosOriginalDownloadingPercent: String { PhotosCopy.shared.PHOTOS_ORIGINAL_DOWNLOADING_PERCENT }
    static var photosOriginalHeldBack: String { PhotosCopy.shared.PHOTOS_ORIGINAL_HELD_BACK }
    static var photosOriginalOnPhone: String { PhotosCopy.shared.PHOTOS_ORIGINAL_ON_PHONE }
    static var photosOriginalYourChoice: String { PhotosCopy.shared.PHOTOS_ORIGINAL_YOUR_CHOICE }
    static var photosPeopleAllMatched: String { PhotosCopy.shared.PHOTOS_PEOPLE_ALL_MATCHED }
    static var photosPeopleNone: String { PhotosCopy.shared.PHOTOS_PEOPLE_NONE }
    static var photosPeopleNoneNamed: String { PhotosCopy.shared.PHOTOS_PEOPLE_NONE_NAMED }
    static var photosPeopleNoneNamedCaption: String { PhotosCopy.shared.PHOTOS_PEOPLE_NONE_NAMED_CAPTION }
    static var photosPeopleNotLooked: String { PhotosCopy.shared.PHOTOS_PEOPLE_NOT_LOOKED }
    static var photosPeopleNotLookedCaption: String { PhotosCopy.shared.PHOTOS_PEOPLE_NOT_LOOKED_CAPTION }
    static var photosPeopleNoOne: String { PhotosCopy.shared.PHOTOS_PEOPLE_NO_ONE }
    static var photosPeopleOff: String { PhotosCopy.shared.PHOTOS_PEOPLE_OFF }
    static var photosPeopleOffCaption: String { PhotosCopy.shared.PHOTOS_PEOPLE_OFF_CAPTION }
    static var photosPeopleToNameCaption: String { PhotosCopy.shared.PHOTOS_PEOPLE_TO_NAME_CAPTION }
    static var photosPeopleUnreadable: String { PhotosCopy.shared.PHOTOS_PEOPLE_UNREADABLE }
    static var photosPermissionDenied: String { PhotosCopy.shared.PHOTOS_PERMISSION_DENIED }
    static var photosPermissionLimited: String { PhotosCopy.shared.PHOTOS_PERMISSION_LIMITED }
    static var photosPermissionNotAsked: String { PhotosCopy.shared.PHOTOS_PERMISSION_NOT_ASKED }
    static var photosPermissionRestricted: String { PhotosCopy.shared.PHOTOS_PERMISSION_RESTRICTED }
    static var photosPickerNothingChosen: String { PhotosCopy.shared.PHOTOS_PICKER_NOTHING_CHOSEN }
    static var photosPickerNothingLeft: String { PhotosCopy.shared.PHOTOS_PICKER_NOTHING_LEFT }
    static var photosPlacesEmpty: String { PhotosCopy.shared.PHOTOS_PLACES_EMPTY }
    static var photosPlacesEmptyCaption: String { PhotosCopy.shared.PHOTOS_PLACES_EMPTY_CAPTION }
    static var photosPlacesMapEmpty: String { PhotosCopy.shared.PHOTOS_PLACES_MAP_EMPTY }
    static var photosPlacesMapEmptyCaption: String { PhotosCopy.shared.PHOTOS_PLACES_MAP_EMPTY_CAPTION }
    static var photosPlacesMapNote: String { PhotosCopy.shared.PHOTOS_PLACES_MAP_NOTE }
    static var photosPlacesNameThis: String { PhotosCopy.shared.PHOTOS_PLACES_NAME_THIS }
    static var photosPlacesSpoken: String { PhotosCopy.shared.PHOTOS_PLACES_SPOKEN }
    static var photosPlacesUnpinnedMany: String { PhotosCopy.shared.PHOTOS_PLACES_UNPINNED_MANY }
    static var photosPlacesUnpinnedOne: String { PhotosCopy.shared.PHOTOS_PLACES_UNPINNED_ONE }
    static var photosPlacesUnplacedMany: String { PhotosCopy.shared.PHOTOS_PLACES_UNPLACED_MANY }
    static var photosPlacesUnplacedManyCapped: String { PhotosCopy.shared.PHOTOS_PLACES_UNPLACED_MANY_CAPPED }
    static var photosPlacesUnplacedOne: String { PhotosCopy.shared.PHOTOS_PLACES_UNPLACED_ONE }
    static var photosPlacesUnplacedOneCapped: String { PhotosCopy.shared.PHOTOS_PLACES_UNPLACED_ONE_CAPPED }
    static var photosPlaceHere: String { PhotosCopy.shared.PHOTOS_PLACE_HERE }
    static var photosPlaceUnreadable: String { PhotosCopy.shared.PHOTOS_PLACE_UNREADABLE }
    static var photosPreviewGone: String { PhotosCopy.shared.PHOTOS_PREVIEW_GONE }
    static var photosPrevious: String { PhotosCopy.shared.PHOTOS_PREVIOUS }
    static var photosRemoveFromAlbum: String { PhotosCopy.shared.PHOTOS_REMOVE_FROM_ALBUM }
    static var photosRenameAlbum: String { PhotosCopy.shared.PHOTOS_RENAME_ALBUM }
    static var photosReviewChecked: String { PhotosCopy.shared.PHOTOS_REVIEW_CHECKED }
    static var photosReviewChooseFirst: String { PhotosCopy.shared.PHOTOS_REVIEW_CHOOSE_FIRST }
    static var photosReviewInAlbum: String { PhotosCopy.shared.PHOTOS_REVIEW_IN_ALBUM }
    static var photosReviewKeeping: String { PhotosCopy.shared.PHOTOS_REVIEW_KEEPING }
    static var photosReviewNone: String { PhotosCopy.shared.PHOTOS_REVIEW_NONE }
    static var photosReviewNoneCaption: String { PhotosCopy.shared.PHOTOS_REVIEW_NONE_CAPTION }
    static var photosReviewNoCaptureTime: String { PhotosCopy.shared.PHOTOS_REVIEW_NO_CAPTURE_TIME }
    static var photosReviewPick: String { PhotosCopy.shared.PHOTOS_REVIEW_PICK }
    static var photosReviewPickCaption: String { PhotosCopy.shared.PHOTOS_REVIEW_PICK_CAPTION }
    static var photosReviewThisCopy: String { PhotosCopy.shared.PHOTOS_REVIEW_THIS_COPY }
    static var photosReviewTrashMany: String { PhotosCopy.shared.PHOTOS_REVIEW_TRASH_MANY }
    static var photosReviewTrashOther: String { PhotosCopy.shared.PHOTOS_REVIEW_TRASH_OTHER }
    static var photosReviewTrashOthers: String { PhotosCopy.shared.PHOTOS_REVIEW_TRASH_OTHERS }
    static var photosReviewUnchecked: String { PhotosCopy.shared.PHOTOS_REVIEW_UNCHECKED }
    static var photosSavedAsNew: String { PhotosCopy.shared.PHOTOS_SAVED_AS_NEW }
    static var photosSaveAsNew: String { PhotosCopy.shared.PHOTOS_SAVE_AS_NEW }
    static var photosSaveAsNewExplanation: String { PhotosCopy.shared.PHOTOS_SAVE_AS_NEW_EXPLANATION }
    static var photosSearchHint: String { PhotosCopy.shared.PHOTOS_SEARCH_HINT }
    static var photosSearchLibraryPlaceholder: String { PhotosCopy.shared.PHOTOS_SEARCH_LIBRARY_PLACEHOLDER }
    static var photosSearchNoMatchScope: String { PhotosCopy.shared.PHOTOS_SEARCH_NO_MATCH_SCOPE }
    static var photosSearchNoResults: String { PhotosCopy.shared.PHOTOS_SEARCH_NO_RESULTS }
    static var photosSearchPlaceholder: String { PhotosCopy.shared.PHOTOS_SEARCH_PLACEHOLDER }
    static var photosSendCopy: String { PhotosCopy.shared.PHOTOS_SEND_COPY }
    static var photosSendExactDetailLocated: String { PhotosCopy.shared.PHOTOS_SEND_EXACT_DETAIL_LOCATED }
    static var photosSendExactDetailUnlocated: String { PhotosCopy.shared.PHOTOS_SEND_EXACT_DETAIL_UNLOCATED }
    static var photosSendExactLocation: String { PhotosCopy.shared.PHOTOS_SEND_EXACT_LOCATION }
    static var photosSendNameDetail: String { PhotosCopy.shared.PHOTOS_SEND_NAME_DETAIL }
    static var photosSendNoneDetail: String { PhotosCopy.shared.PHOTOS_SEND_NONE_DETAIL }
    static var photosSendNotRemovable: String { PhotosCopy.shared.PHOTOS_SEND_NOT_REMOVABLE }
    static var photosSendNoLocation: String { PhotosCopy.shared.PHOTOS_SEND_NO_LOCATION }
    static var photosSendOriginalNotHere: String { PhotosCopy.shared.PHOTOS_SEND_ORIGINAL_NOT_HERE }
    static var photosSendPlaceNameOnly: String { PhotosCopy.shared.PHOTOS_SEND_PLACE_NAME_ONLY }
    static var photosSendPlaceTitle: String { PhotosCopy.shared.PHOTOS_SEND_PLACE_TITLE }
    static var photosSentExact: String { PhotosCopy.shared.PHOTOS_SENT_EXACT }
    static var photosSentNameOnly: String { PhotosCopy.shared.PHOTOS_SENT_NAME_ONLY }
    static var photosSentNone: String { PhotosCopy.shared.PHOTOS_SENT_NONE }
    static var photosShelfNothing: String { PhotosCopy.shared.PHOTOS_SHELF_NOTHING }
    static var photosShelfTitle: String { PhotosCopy.shared.PHOTOS_SHELF_TITLE }
    static var photosSlideshowLine: String { PhotosCopy.shared.PHOTOS_SLIDESHOW_LINE }
    static var photosSmallerCopyOnly: String { PhotosCopy.shared.PHOTOS_SMALLER_COPY_ONLY }
    static var photosThisPhoto: String { PhotosCopy.shared.PHOTOS_THIS_PHOTO }
    static var photosTrashBody: String { PhotosCopy.shared.PHOTOS_TRASH_BODY }
    static var photosTrashMany: String { PhotosCopy.shared.PHOTOS_TRASH_MANY }
    static var photosTrashOne: String { PhotosCopy.shared.PHOTOS_TRASH_ONE }
    static var photosUnarchive: String { PhotosCopy.shared.PHOTOS_UNARCHIVE }
    static var photosUnfavorite: String { PhotosCopy.shared.PHOTOS_UNFAVORITE }
    static var photosUntitledAlbum: String { PhotosCopy.shared.PHOTOS_UNTITLED_ALBUM }
    static var photosVideoStatus: String { PhotosCopy.shared.PHOTOS_VIDEO_STATUS }
    static var photosVideoStillOnly: String { PhotosCopy.shared.PHOTOS_VIDEO_STILL_ONLY }
    static var photosWhoInIt: String { PhotosCopy.shared.PHOTOS_WHO_IN_IT }
    static var placeNoLocation: String { PhotosCopy.shared.PLACE_NO_LOCATION }
    static var placeUnnamed: String { PhotosCopy.shared.PLACE_UNNAMED }
    static var tileCountMany: String { PhotosCopy.shared.TILE_COUNT_MANY }
    static var tileCountOne: String { PhotosCopy.shared.TILE_COUNT_ONE }
    static var transferOriginalWaitingMany: String { PhotosCopy.shared.TRANSFER_ORIGINAL_WAITING_MANY }
    static var transferOriginalWaitingOne: String { PhotosCopy.shared.TRANSFER_ORIGINAL_WAITING_ONE }
    static var transferSubtitle: String { PhotosCopy.shared.TRANSFER_SUBTITLE }
    static var transferTitle: String { PhotosCopy.shared.TRANSFER_TITLE }
    static var vaultMoved: String { PhotosCopy.shared.VAULT_MOVED }
    static var vaultNoneYet: String { PhotosCopy.shared.VAULT_NONE_YET }
    static var vaultOnline: String { PhotosCopy.shared.VAULT_ONLINE }
    #else
    static let photograph = ""
    static let photosAddLabel = ""
    static let photosAddPhotos = ""
    static let photosAddPlace = ""
    static let photosAddToAlbum = ""
    static let photosAdjustLocation = ""
    static let photosAlbumChoiceNew = ""
    static let photosAlbumChoiceNone = ""
    static let photosAlbumName = ""
    static let photosAlbumOptions = ""
    static let photosAlbumRefers = ""
    static let photosAlreadyInAlbum = ""
    static let photosAlreadyYours = ""
    static let photosArchive = ""
    static let photosArchiveEmpty = ""
    static let photosCameraRoll = ""
    static let photosCaptionPlaceholder = ""
    static let photosCellNotDownloaded = ""
    static let photosCellPreviewGone = ""
    static let photosChosen = ""
    static let photosClearPlaceDetail = ""
    static let photosCollectionsNoAlbums = ""
    static let photosCollectionsNoAlbumsCaption = ""
    static let photosCollectionsNoMemories = ""
    static let photosCollectionsNoMemoriesCaption = ""
    static let photosCollectionsPeopleCaption = ""
    static let photosCopyExactLocation = ""
    static let photosCropArea = ""
    static let photosCropDown = ""
    static let photosCropHint = ""
    static let photosCropLarger = ""
    static let photosCropLeft = ""
    static let photosCropRight = ""
    static let photosCropSmaller = ""
    static let photosCropUp = ""
    static let photosDeleteAlbum = ""
    static let photosDeleteAlbumBody = ""
    static let photosDeleteAlbumTitle = ""
    static let photosDeleteForever = ""
    static let photosDeleteForeverBody = ""
    static let photosDeleteForeverConfirm = ""
    static let photosDeleteForeverMany = ""
    static let photosDeleteForeverOne = ""
    static let photosDownloadOriginal = ""
    static let photosDuplicatesLooking = ""
    static let photosDuplicatesLookingCaption = ""
    static let photosDuplicatesNoneCaption = ""
    static let photosDuplicatesPickOne = ""
    static let photosDuplicatesSetMany = ""
    static let photosDuplicatesSetOne = ""
    static let photosDuplicatesStillLooking = ""
    static let photosEditorTitle = ""
    static let photosEditCannotDraw = ""
    static let photosEditCannotOpen = ""
    static let photosEditDiscardQuestion = ""
    static let photosEditFromUndated = ""
    static let photosEditKeepEditing = ""
    static let photosEditNotAPhoto = ""
    static let photosEditNotLoaded = ""
    static let photosEditSaving = ""
    static let photosEmptyDuplicates = ""
    static let photosEmptyFavorites = ""
    static let photosEmptyTrash = ""
    static let photosEmptyTrashBody = ""
    static let photosEmptyTrashTitle = ""
    static let photosErrorEditNotSaved = ""
    static let photosErrorExportFailed = ""
    static let photosErrorFreeUpPaused = ""
    static let photosErrorInCloud = ""
    static let photosErrorWriteNotSaved = ""
    static let photosExportSaved = ""
    static let photosFacesAFace = ""
    static let photosFacesKeepUnnamed = ""
    static let photosFacesNewName = ""
    static let photosFacesNone = ""
    static let photosFacesNoneCaption = ""
    static let photosFacesNotThis = ""
    static let photosFacesOffCaption = ""
    static let photosFacesSayWho = ""
    static let photosFacesSkipForNow = ""
    static let photosFacesSomeoneElse = ""
    static let photosFacesWho = ""
    static let photosFavorite = ""
    static let photosFileSizeUnreadable = ""
    static let photosFreeUpTitle = ""
    static let photosGridEmpty = ""
    static let photosGridEmptyCaption = ""
    static let photosGridNoFavorites = ""
    static let photosGridNoFavoritesCaption = ""
    static let photosGridSelect = ""
    static let photosGridSelectedMany = ""
    static let photosGridSelectedOne = ""
    static let photosGridTrashConfirm = ""
    static let photosImportAuto = ""
    static let photosImportDone = ""
    static let photosImportDoneCount = ""
    static let photosImportLooking = ""
    static let photosImportNow = ""
    static let photosImportOff = ""
    static let photosImportPausedDisk = ""
    static let photosImportProgress = ""
    static let photosImportRunning = ""
    static let photosImportWaitCounts = ""
    static let photosImportWaitPower = ""
    static let photosImportWaitWifi = ""
    static let photosKeepIt = ""
    static let photosKeepOriginalsLabel = ""
    static let photosKeepOriginalsTitle = ""
    static let photosKeepThem = ""
    static let photosLabelsNone = ""
    static let photosLabelsUnreadable = ""
    static let photosLibraryLoadingMore = ""
    static let photosLibraryUndatedNote = ""
    static let photosLoadOriginal = ""
    static let photosLocationCopied = ""
    static let photosMakeKey = ""
    static let photosMemoriesEmpty = ""
    static let photosMemoriesEmptyCaption = ""
    static let photosMemoriesNotLooked = ""
    static let photosMemoriesNotLookedCaption = ""
    static let photosMemorySimilar = ""
    static let photosMoreFoot = ""
    static let photosMoreTitle = ""
    static let photosNewAlbum = ""
    static let photosNext = ""
    static let photosNothingOnPhone = ""
    static let photosNotInVault = ""
    static let photosNotOnPhone = ""
    static let photosNotOnPhoneShort = ""
    static let photosNoPlaces = ""
    static let photosOpeningLibrary = ""
    static let photosOriginalDownloading = ""
    static let photosOriginalDownloadingNow = ""
    static let photosOriginalDownloadingPercent = ""
    static let photosOriginalHeldBack = ""
    static let photosOriginalOnPhone = ""
    static let photosOriginalYourChoice = ""
    static let photosPeopleAllMatched = ""
    static let photosPeopleNone = ""
    static let photosPeopleNoneNamed = ""
    static let photosPeopleNoneNamedCaption = ""
    static let photosPeopleNotLooked = ""
    static let photosPeopleNotLookedCaption = ""
    static let photosPeopleNoOne = ""
    static let photosPeopleOff = ""
    static let photosPeopleOffCaption = ""
    static let photosPeopleToNameCaption = ""
    static let photosPeopleUnreadable = ""
    static let photosPermissionDenied = ""
    static let photosPermissionLimited = ""
    static let photosPermissionNotAsked = ""
    static let photosPermissionRestricted = ""
    static let photosPickerNothingChosen = ""
    static let photosPickerNothingLeft = ""
    static let photosPlacesEmpty = ""
    static let photosPlacesEmptyCaption = ""
    static let photosPlacesMapEmpty = ""
    static let photosPlacesMapEmptyCaption = ""
    static let photosPlacesMapNote = ""
    static let photosPlacesNameThis = ""
    static let photosPlacesSpoken = ""
    static let photosPlacesUnpinnedMany = ""
    static let photosPlacesUnpinnedOne = ""
    static let photosPlacesUnplacedMany = ""
    static let photosPlacesUnplacedManyCapped = ""
    static let photosPlacesUnplacedOne = ""
    static let photosPlacesUnplacedOneCapped = ""
    static let photosPlaceHere = ""
    static let photosPlaceUnreadable = ""
    static let photosPreviewGone = ""
    static let photosPrevious = ""
    static let photosRemoveFromAlbum = ""
    static let photosRenameAlbum = ""
    static let photosReviewChecked = ""
    static let photosReviewChooseFirst = ""
    static let photosReviewInAlbum = ""
    static let photosReviewKeeping = ""
    static let photosReviewNone = ""
    static let photosReviewNoneCaption = ""
    static let photosReviewNoCaptureTime = ""
    static let photosReviewPick = ""
    static let photosReviewPickCaption = ""
    static let photosReviewThisCopy = ""
    static let photosReviewTrashMany = ""
    static let photosReviewTrashOther = ""
    static let photosReviewTrashOthers = ""
    static let photosReviewUnchecked = ""
    static let photosSavedAsNew = ""
    static let photosSaveAsNew = ""
    static let photosSaveAsNewExplanation = ""
    static let photosSearchHint = ""
    static let photosSearchLibraryPlaceholder = ""
    static let photosSearchNoMatchScope = ""
    static let photosSearchNoResults = ""
    static let photosSearchPlaceholder = ""
    static let photosSendCopy = ""
    static let photosSendExactDetailLocated = ""
    static let photosSendExactDetailUnlocated = ""
    static let photosSendExactLocation = ""
    static let photosSendNameDetail = ""
    static let photosSendNoneDetail = ""
    static let photosSendNotRemovable = ""
    static let photosSendNoLocation = ""
    static let photosSendOriginalNotHere = ""
    static let photosSendPlaceNameOnly = ""
    static let photosSendPlaceTitle = ""
    static let photosSentExact = ""
    static let photosSentNameOnly = ""
    static let photosSentNone = ""
    static let photosShelfNothing = ""
    static let photosShelfTitle = ""
    static let photosSlideshowLine = ""
    static let photosSmallerCopyOnly = ""
    static let photosThisPhoto = ""
    static let photosTrashBody = ""
    static let photosTrashMany = ""
    static let photosTrashOne = ""
    static let photosUnarchive = ""
    static let photosUnfavorite = ""
    static let photosUntitledAlbum = ""
    static let photosVideoStatus = ""
    static let photosVideoStillOnly = ""
    static let photosWhoInIt = ""
    static let placeNoLocation = ""
    static let placeUnnamed = ""
    static let tileCountMany = ""
    static let tileCountOne = ""
    static let transferOriginalWaitingMany = ""
    static let transferOriginalWaitingOne = ""
    static let transferSubtitle = ""
    static let transferTitle = ""
    static let vaultMoved = ""
    static let vaultNoneYet = ""
    static let vaultOnline = ""
    #endif

    /// Closes one `{hole}` in a template.
    static func fill(_ template: String, _ hole: String, _ value: String) -> String {
        template.replacingOccurrences(of: "{\(hole)}", with: value)
    }
}
