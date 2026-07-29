import ExpoModulesCore

public class CentraidNetworkStatusModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CentraidNetworkStatus")

    // iOS has no public, reliable roaming-status API. Returning nil keeps that
    // uncertainty explicit so policy can block rather than silently spend data.
    AsyncFunction("isNetworkRoaming") { () -> Bool? in
      nil
    }
  }
}
