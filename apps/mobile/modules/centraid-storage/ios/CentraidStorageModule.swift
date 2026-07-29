import ExpoModulesCore
import Foundation

public class CentraidStorageModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CentraidStorage")

    Function("replicaDirectory") { () throws -> String in
      let manager = FileManager.default
      guard let support = manager.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      ).first else {
        throw NSError(
          domain: "CentraidStorage",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Application Support directory unavailable"]
        )
      }
      let directory = support.appendingPathComponent(
        "CentraidReplica",
        isDirectory: true
      )
      try manager.createDirectory(
        at: directory,
        withIntermediateDirectories: true
      )
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var mutable = directory
      try mutable.setResourceValues(values)
      try manager.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: directory.path
      )
      return directory.path
    }

    Function("directorySize") { (path: String) -> Double in
      let manager = FileManager.default
      guard let enumerator = manager.enumerator(
        at: URL(fileURLWithPath: path),
        includingPropertiesForKeys: [.fileSizeKey],
        options: [.skipsHiddenFiles]
      ) else { return 0 }
      var total: Int64 = 0
      for case let url as URL in enumerator {
        total += Int64(
          (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        )
      }
      return Double(total)
    }
  }
}
