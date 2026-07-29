# Mobile store submission checklist

This is the required preflight for both iOS and Android. It records the
product behavior represented by the checked native config; it is not a
substitute for reviewing the generated archive in App Store Connect and Play
Console.

## Privacy labels

- Apple privacy nutrition label: **Data Not Collected** by the developer.
  Personal vault data, photos, contacts, documents, financial entries, search
  text, and diagnostics stay on the user's devices and their paired
  self-hosted gateway. Centraid has no developer-operated analytics or
  advertising endpoint.
- Google Play Data safety: **No data collected** and **No data shared** by the
  developer. Transfers to the gateway selected by the user are
  user-initiated/self-hosted product operation, not developer collection.
- Tracking: no advertising identifier, cross-app tracking, fingerprinting, or
  tracking SDK. Both committed Apple privacy manifests declare
  `NSPrivacyTracking = false` and no collected data types.
- Recheck these answers whenever an analytics, crash-reporting, hosted relay,
  push, or account service is added. A developer-operated service changes the
  labels even when payloads are minimized.

## Permissions and background work

- Camera: pairing QR codes and captures the user explicitly starts.
- Photos: reads selected albums for the local-first library/backup flow and
  writes only when the user exports to the device library.
- Face ID / biometrics: protects the local replica and gates Locker reveals.
- Local network: connects only to the gateway the user pairs.
- Microphone: used only for user-started video capture with sound.
- Notifications: event/task reminders, the content-minimized Daily Brief, and
  data-only replica wakeups. The app never prompts merely to schedule the
  Daily Brief.
- iOS `processing` background mode is owned by
  `src/lib/replica/background-sync.ts`; its Expo BackgroundTask identifier is
  present in the generated Info.plist. `remote-notification` is owned by the
  data-only replica wake task in the same module. Payloads contain no vault,
  item, secret, or content metadata.
- Android background upload is owned by the checked native foreground service.
  Review the Play Console foreground-service declaration against the generated
  manifest for each release.

## Export compliance

- `ITSAppUsesNonExemptEncryption = false`: the app uses OS-provided TLS,
  authentication/keychain protection, and published standard cryptographic
  algorithms for the user's data; it does not ship proprietary or
  non-standard encryption.
- Reconfirm this answer with release/legal review if cryptographic behavior,
  distribution countries, or Apple guidance changes.

## Accessibility review

- Run keyboard-only web/PWA coverage and VoiceOver + TalkBack journeys for all
  eight blueprint covers, modal/sheet focus, Photos lightbox, destructive
  confirmations, toasts/undo, and Dynamic Type at the largest accessibility
  size.
- Verify icon-only controls have spoken labels, selected/disabled/busy state is
  announced, focus returns after every modal, and no required text is clipped.

## Submission evidence

- Attach iOS and Android device recordings, accessibility walkthrough notes,
  permission screenshots, privacy-label screenshots, and the green
  `mobile-e2e-ios` / Android journey runs to the release receipt.
- Compare generated Info.plist, AndroidManifest.xml, and both
  `PrivacyInfo.xcprivacy` files with this checklist before upload.
