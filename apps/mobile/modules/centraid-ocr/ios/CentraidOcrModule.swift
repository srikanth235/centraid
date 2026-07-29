import ExpoModulesCore
import Foundation
import UIKit
import Vision

private let maxBytes: UInt64 = 25 * 1024 * 1024
private let maxPixels = 20_000_000

public class CentraidOcrModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CentraidOcr")

    AsyncFunction("recognizeText") { (uri: String) throws -> [String: Any] in
      let url = try localFileUrl(uri)
      let values = try url.resourceValues(forKeys: [.fileSizeKey])
      guard UInt64(values.fileSize ?? 0) <= maxBytes else {
        throw OcrError("Scan exceeds the 25 MB on-device OCR limit.")
      }
      guard
        let image = UIImage(contentsOfFile: url.path),
        let cgImage = image.cgImage
      else {
        throw OcrError("The selected file is not a readable image.")
      }
      guard cgImage.width * cgImage.height <= maxPixels else {
        throw OcrError("Scan exceeds the 20 megapixel on-device OCR limit.")
      }

      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.usesLanguageCorrection = true
      try VNImageRequestHandler(cgImage: cgImage).perform([request])
      let lines: [[String: Any]] = (request.results ?? []).compactMap { item in
        guard let candidate = item.topCandidates(1).first else { return nil }
        return [
          "text": candidate.string,
          "confidence": Double(candidate.confidence)
        ]
      }
      let confidence = lines.isEmpty
        ? 0
        : lines.reduce(0) { $0 + (($1["confidence"] as? Double) ?? 0) }
          / Double(lines.count)
      return [
        "text": lines.compactMap { $0["text"] as? String }.joined(separator: "\n"),
        "confidence": confidence,
        "lines": lines,
        "engine": "apple-vision"
      ]
    }
  }
}

private func localFileUrl(_ raw: String) throws -> URL {
  guard let url = URL(string: raw), url.isFileURL else {
    throw OcrError("OCR accepts local file URLs only.")
  }
  return url
}

private struct OcrError: Error, LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
