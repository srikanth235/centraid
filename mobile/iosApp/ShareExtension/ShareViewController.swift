#if canImport(UIKit)
import Foundation
import UIKit
import UniformTypeIdentifiers

@MainActor
final class ShareViewController: UIViewController {
    private var started = false

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        Task { [weak self] in
            await self?.processSharedItems()
        }
    }

    private func processSharedItems() async {
        guard let context = extensionContext else { return }
        let items = context.inputItems.compactMap { $0 as? NSExtensionItem }
        let providers = items.flatMap { $0.attachments ?? [] }
        let fromApp = items.first?.attributedTitle?.string ?? ""

        guard let writer = try? ShareInboxWriter.defaultWriter() else {
            context.cancelRequest(withError: ShareInboxWriter.Failure.noContainer)
            return
        }

        for provider in providers {
            if Task.isCancelled { break }
            await saveProvider(provider, writer: writer, fromApp: fromApp)
        }

        context.completeRequest(returningItems: nil)
    }

    private func saveProvider(
        _ provider: NSItemProvider,
        writer: ShareInboxWriter,
        fromApp: String
    ) async {
        let suggestedName = provider.suggestedName ?? ""

        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            if let fileURL = await loadFileURL(from: provider) {
                let uti = preferredUTI(for: fileURL, provider: provider)
                _ = try? writer.writeFile(
                    at: fileURL,
                    utiOrMime: uti,
                    name: fileURL.lastPathComponent,
                    fromApp: fromApp
                )
                return
            }
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            let uti = specificTypeIdentifier(for: provider, conformingTo: .image) ?? UTType.image.identifier
            if await copyFileRepresentation(provider, typeIdentifier: uti, suggestedName: suggestedName, writer: writer, fromApp: fromApp) {
                return
            }
            if let data = await loadDataRepresentation(provider, typeIdentifier: uti) {
                _ = try? writer.writeData(
                    data,
                    kind: .file,
                    utiOrMime: uti,
                    name: filename(suggested: suggestedName, uti: uti, fallback: "image"),
                    fromApp: fromApp
                )
                return
            }
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
            let uti = specificTypeIdentifier(for: provider, conformingTo: .movie) ?? UTType.movie.identifier
            if await copyFileRepresentation(provider, typeIdentifier: uti, suggestedName: suggestedName, writer: writer, fromApp: fromApp) {
                return
            }
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
            if await copyFileRepresentation(provider, typeIdentifier: UTType.pdf.identifier, suggestedName: suggestedName, writer: writer, fromApp: fromApp) {
                return
            }
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let url = await loadURL(from: provider) {
                if url.isFileURL {
                    let uti = preferredUTI(for: url, provider: provider)
                    _ = try? writer.writeFile(
                        at: url,
                        utiOrMime: uti,
                        name: url.lastPathComponent,
                        fromApp: fromApp
                    )
                } else {
                    _ = try? writer.writeURL(url, name: suggestedName, fromApp: fromApp)
                }
                return
            }
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let text = await loadText(from: provider), !text.isEmpty {
                _ = try? writer.writeText(text, name: suggestedName, fromApp: fromApp)
                return
            }
        }

        if let fallbackType = provider.registeredTypeIdentifiers.first {
            _ = await copyFileRepresentation(provider, typeIdentifier: fallbackType, suggestedName: suggestedName, writer: writer, fromApp: fromApp)
        }
    }

    private func copyFileRepresentation(
        _ provider: NSItemProvider,
        typeIdentifier: String,
        suggestedName: String,
        writer: ShareInboxWriter,
        fromApp: String
    ) async -> Bool {
        await withCheckedContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, _ in
                guard let url else {
                    continuation.resume(returning: false)
                    return
                }
                let name = url.lastPathComponent.isEmpty
                    ? self.filename(suggested: suggestedName, uti: typeIdentifier, fallback: "shared")
                    : url.lastPathComponent
                let mimeOrUTI = UTType(typeIdentifier)?.preferredMIMEType ?? typeIdentifier
                let ok = (try? writer.writeFile(
                    at: url,
                    utiOrMime: mimeOrUTI,
                    name: name,
                    fromApp: fromApp
                )) != nil
                continuation.resume(returning: ok)
            }
        }
    }

    private func loadDataRepresentation(_ provider: NSItemProvider, typeIdentifier: String) async -> Data? {
        await withCheckedContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, _ in
                continuation.resume(returning: data)
            }
        }
    }

    private func loadFileURL(from provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                if let url = item as? URL {
                    continuation.resume(returning: url)
                } else if let data = item as? Data, let url = URL(dataRepresentation: data, relativeTo: nil) {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    private func loadURL(from provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                if let url = item as? URL {
                    continuation.resume(returning: url)
                } else if let string = item as? String, let url = URL(string: string) {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    private func loadText(from provider: NSItemProvider) async -> String? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, _ in
                if let text = item as? String {
                    continuation.resume(returning: text)
                } else if let data = item as? Data, let text = String(data: data, encoding: .utf8) {
                    continuation.resume(returning: text)
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    nonisolated private func specificTypeIdentifier(for provider: NSItemProvider, conformingTo base: UTType) -> String? {
        provider.registeredTypeIdentifiers.first { identifier in
            guard let type = UTType(identifier) else { return false }
            return type.conforms(to: base)
        }
    }

    nonisolated private func preferredUTI(for fileURL: URL, provider: NSItemProvider) -> String {
        if !fileURL.pathExtension.isEmpty,
           let type = UTType(filenameExtension: fileURL.pathExtension) {
            return type.preferredMIMEType ?? type.identifier
        }
        if let first = provider.registeredTypeIdentifiers.first,
           let type = UTType(first) {
            return type.preferredMIMEType ?? type.identifier
        }
        return UTType.data.identifier
    }

    nonisolated private func filename(suggested: String, uti: String, fallback: String) -> String {
        let base = suggested.isEmpty ? fallback : suggested
        if URL(fileURLWithPath: base).pathExtension.isEmpty,
           let ext = UTType(uti)?.preferredFilenameExtension {
            return "\(base).\(ext)"
        }
        return base
    }
}
#endif
