import Contacts
import ContactsUI
import EventKit
import SwiftUI

import CentraidShared

// ONBOARDING WITHOUT SAMPLE DATA (docs/decisions.md, "Onboarding without sample
// data"): where the phone already holds an app's data, its day-one empty state
// offers a one-tap import asked at the point of use. These are the shell's
// halves: the environment door the kit's `EmptyStateView` reads, the banner the
// import draws, and the address-book read.

private struct ImportFromPhoneKey: EnvironmentKey {
    static let defaultValue: ((Centraid_Screen_V1_ImportSource) -> Void)? = nil
}

extension EnvironmentValues {
    /// An import from where the phone already holds the data, or nil.
    var importFromPhone: ((Centraid_Screen_V1_ImportSource) -> Void)? {
        get { self[ImportFromPhoneKey.self] }
        set { self[ImportFromPhoneKey.self] = newValue }
    }
}

/// THE IMPORT'S STATUS LINE (DESIGN.md: "`StatusLine` is the one feedback
/// channel … docked to the bottom of the frame … no floating overlay, no
/// auto-dismiss"): an import's progress and outcome, above the band, on Home
/// and on every app. One fragment, at most one action ("Open People", which
/// takes the member to what came in), and a close key once the work is done.
/// It never clears on a timer: the close key, the action or the member's next
/// move puts it away (`ShellModel.importLineMoved`).
struct ShellBanner: View {
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            if !shell.importNotice.isEmpty {
                VStack(spacing: 0) {
                    KitHairline()
                    ProgressStatusLine(
                        sentence: shell.importNotice,
                        actionLabel: shell.importing ? "" : PhoneImport.shared.openLabel(app: shell.importOpens),
                        onAct: { shell.openImported() },
                        closeLabel: shell.importing ? "" : KitWords.shared.DISMISS,
                        onClose: { shell.dismissImportNotice() },
                        identifier: "import"
                    )
                }
                .background(Theme.color("bg", scheme))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("import-banner")
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            }
        }
        // ENTRY AND SETTLE AT 280MS, a change of words at 140 (DESIGN.md's one motion grammar).
        .animation(reduceMotion ? nil : .easeOut(duration: 0.28), value: shell.importNotice.isEmpty)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: shell.importNotice)
    }
}

/// THE IMPORT LINE ON A PUSHED PAGE: handed to `AppPlace`, which draws it above
/// its band; a page with no `AppPlace` (a row's page, an editor) gets it docked
/// at its own foot instead, so it is in the same place everywhere.
struct ShellLineHost: ViewModifier {
    @ObservedObject var shell: ShellModel
    @State private var placeDraws = false

    func body(content: Content) -> some View {
        content
            .environment(\.shellStatusLine, AnyView(ShellBanner(shell: shell)))
            .onPreferenceChange(PlaceDrawsShellLine.self) { placeDraws = $0 }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !placeDraws { ShellBanner(shell: shell) }
            }
    }
}

/// THE PHONE'S ADDRESS BOOK. Read once the member taps "Import contacts" (the OS
/// asks its own permission then, never at launch), and again, with no prompt, by
/// the follower whenever the OS says the book changed and access is already
/// granted (#1127).
///
/// **One origin per `CNContainer`** (R-1127-10): an account, as iOS names it
/// ("iCloud", "Gmail"), so a whole account that leaves the phone is one question.
/// A contact is its UNIFIED contact, so `phoneId` is `local:` plus the unified
/// identifier; one linked across two containers is read once per container and
/// the shared `ContactsImport` keeps it under one origin. **A read is complete
/// unless access is limited (iOS 18) or a container would not read.**
enum PhoneContacts {
    enum Outcome {
        case denied
        case read(ContactsRead)
    }

    /// The tap: ask the OS, then read.
    static func read() async -> Outcome {
        let store = CNContactStore()
        let granted = (try? await store.requestAccess(for: .contacts)) ?? false
        guard granted else { return .denied }
        return await Task.detached(priority: .userInitiated) { .read(snapshot(store)) }.value
    }

    /// Access the member has already given, in full or in part. Never prompts.
    static var granted: Bool {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        if #available(iOS 18.0, *), status == .limited { return true }
        return status == .authorized
    }

    /// The follower's read: nil when access is not already granted.
    static func readIfGranted() async -> ContactsRead? {
        guard granted else { return nil }
        let store = CNContactStore()
        return await Task.detached(priority: .utility) { snapshot(store) }.value
    }

    /// LIMITED ACCESS (iOS 18): the member shared only the contacts they
    /// picked, so asking again draws no prompt and reads only those. The
    /// import then offers iOS's own picker (`ContactAccessPicker`) to share
    /// more, and reads again.
    static var limited: Bool {
        if #available(iOS 18.0, *) {
            return CNContactStore.authorizationStatus(for: .contacts) == .limited
        }
        return false
    }

    /// Every container present (empty ones too, so one with no contact is not
    /// taken for gone) and the contacts in each.
    static func snapshot(_ store: CNContactStore) -> ContactsRead {
        var complete = !limited
        var containers: [CNContainer] = []
        do {
            containers = try store.containers(matching: nil)
        } catch {
            complete = false
        }
        var origins: [PhoneOriginRef] = []
        var found: [PhoneContact] = []
        for container in containers.sorted(by: { $0.identifier < $1.identifier }) {
            let origin = ContactsImport.shared.container(id: container.identifier, name: container.name)
            origins.append(origin)
            let predicate = CNContact.predicateForContactsInContainer(withIdentifier: container.identifier)
            if !enumerate(store, predicate: predicate, origin: origin, into: &found) { complete = false }
        }
        return ContactsRead(contacts: found, origins: origins, complete: complete)
    }

    /// False when the container would not read: the read is then incomplete.
    private static func enumerate(
        _ store: CNContactStore,
        predicate: NSPredicate,
        origin: PhoneOriginRef,
        into found: inout [PhoneContact]
    ) -> Bool {
        let keys: [CNKeyDescriptor] = [
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
            CNContactBirthdayKey as CNKeyDescriptor,
        ]
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.predicate = predicate
        do {
            try store.enumerateContacts(with: request) { contact, _ in
                let name = CNContactFormatter.string(from: contact, style: .fullName) ?? contact.organizationName
                found.append(
                    PhoneContact(
                        name: name,
                        phones: contact.phoneNumbers.map { $0.value.stringValue },
                        emails: contact.emailAddresses.map { $0.value as String },
                        birthday: monthDay(contact.birthday),
                        // R-1127-10: the unified identifier means something on this device only.
                        phoneId: "local:" + contact.identifier,
                        origin: origin.id,
                        originLabel: origin.label
                    )
                )
            }
            return true
        } catch {
            return false
        }
    }

    /// `MM-DD`, or empty: a People important date is a day of the year.
    private static func monthDay(_ birthday: DateComponents?) -> String {
        guard let month = birthday?.month, let day = birthday?.day else { return "" }
        return String(format: "%02d-%02d", month, day)
    }
}

/// IOS'S OWN CONTACT PICKER (`ContactAccessPicker`, iOS 18), raised when People's
/// import meets limited access: the member shares more contacts in the
/// system's sheet, and the identifiers it hands back are imported. Before
/// iOS 18 there is no limited access, so there is nothing to raise.
struct ContactAccessPickerHost: ViewModifier {
    @ObservedObject var shell: ShellModel

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.contactAccessPicker(isPresented: $shell.contactAccessPickerShown) { identifiers in
                shell.contactsShared(identifiers)
            }
        } else {
            content
        }
    }
}

/// THE FOLLOWER'S ADDRESS-BOOK READER (#1127): read off the main thread, only
/// over access the member already gave. nil is "not granted", and the pass ends.
final class ContactsFollowReader: NSObject, ContactsReader {
    // (Kotlin/Native gives this protocol's parameter a trailing underscore; CalendarReader's has none.)
    func read(deliver_: @escaping (ContactsRead?) -> Void) {
        Task.detached(priority: .utility) { deliver_(await PhoneContacts.readIfGranted()) }
    }
}

/// THE QUESTION A HELD ACCOUNT OR CALENDAR LEAVES (R-1127-9), in the kit's
/// `ConfirmSheet` (DESIGN.md: a destructive confirm is never an alert). The
/// shared question chose every word and built the confirm: Move to trash is
/// its destructive verb, and KEEP, THE DEFAULT, is the sheet's cancel and what
/// a swipe away means.
struct PhoneFollowQuestionHost: ViewModifier {
    @ObservedObject var shell: ShellModel

    /// One sheet per question: a second question is a new sheet, not the first one's words swapped.
    private struct Asked: Identifiable {
        let question: PhoneFollowQuestion
        var id: String { question.originId }
    }

    func body(content: Content) -> some View {
        content.sheet(item: Binding(
            get: { shell.followQuestion.map(Asked.init) },
            set: { if $0 == nil, shell.followQuestion != nil { shell.answerFollowQuestion(keep: true) } }
        )) { asked in
            ConfirmSheet(
                (try? Centraid_Screen_V1_Confirm(serializedBytes: asked.question.confirmBytes.data)) ?? .init(),
                cancelLabel: asked.question.keepLabel,
                onConfirm: { shell.answerFollowQuestion(keep: false) },
                onDismiss: { shell.answerFollowQuestion(keep: true) }
            )
        }
    }
}
