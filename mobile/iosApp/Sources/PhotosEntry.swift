import Foundation

/// WHERE THE SHELL ENTERS PHOTOS' ONE-PHOTOGRAPH PAGES FROM OUTSIDE THEM (#1135):
/// a KMP grid or shelf that has not moved yet, Home's search, a chat card. Inside
/// the lightbox, the editor and Duplicates a row carries the `Route` Rust built;
/// these are the routes the shell spells because the caller holds an id and no
/// row. Push one with `ShellModel.open`.
///
/// INTERIM: the shell lane (#1135) replaces the KMP stack with Rust's and deletes
/// this file; a front door then asks Rust for the route.
enum PhotosEntry {
    /// One photograph. `neighbours` is the order of the shelf that opened it, so a
    /// swipe is a move and never a read; `album` is the album it was opened from,
    /// empty from anywhere else, so "Make key photo" knows which cover it sets.
    static func lightbox(
        _ photoID: String,
        neighbours: [String] = [],
        album: String = ""
    ) -> Centraid_Core_V1_Route {
        var args = Centraid_Core_V1_PhotosLightboxRoute()
        args.photoID = photoID
        args.neighbourIds = neighbours
        args.albumID = album
        var route = Centraid_Core_V1_Route()
        route.screen = "photos.lightbox"
        route.photosLightbox = args
        return route
    }

    /// The near-duplicate sets.
    static func duplicates() -> Centraid_Core_V1_Route {
        var route = Centraid_Core_V1_Route()
        route.screen = "photos.duplicates"
        route.photosDuplicates = .init()
        return route
    }
}
