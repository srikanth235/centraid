import Contacts
import ContactsUI
import SwiftUI

/// THE PHONE'S ADDRESS BOOK, READ FOR THE CORE (#1135): the `ContactsRead`
/// effect answered with a `ContactsSnapshot` — every container present (an
/// empty one too) and the unified contacts in each. Rust squashes names, keeps
/// a contact once and makes every record; this reads and words nothing.
/// iOS asks its own permission only when the effect says the member's tap may
/// ask, never at launch.
///
/// **A read is complete unless access is limited (iOS 18) or a container would
/// not read** (R-1127-10), so nothing is trashed on a partial read.
enum PhoneContacts {
    /// Access the member has already given, in full or in part. Never prompts.
    static var granted: Bool {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        if #available(iOS 18.0, *), status == .limited { return true }
        return status == .authorized
    }

    /// LIMITED ACCESS (iOS 18): the member shared only the contacts they
    /// picked; iOS's own picker shares more.
    static var limited: Bool {
        if #available(iOS 18.0, *) {
            return CNContactStore.authorizationStatus(for: .contacts) == .limited
        }
        return false
    }

    /// The effect's answer: a snapshot, or a refusal by value when access is not given.
    static func snapshot(_ read: Centraid_Core_V1_ContactsRead) async -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        let store = CNContactStore()
        if read.askPermission {
            guard (try? await store.requestAccess(for: .contacts)) ?? false else { return .failed(denied()) }
        } else if !granted {
            return .failed(denied())
        }
        return await Task.detached(priority: .utility) { .contacts(snapshot(store)) }.value
    }

    private static func denied() -> Centraid_Core_V1_EffectFailed {
        var failed = Centraid_Core_V1_EffectFailed()
        failed.reason = "contacts access not given"
        failed.denied = true
        return failed
    }

    private static func snapshot(_ store: CNContactStore) -> Centraid_Core_V1_ContactsSnapshot {
        var out = Centraid_Core_V1_ContactsSnapshot()
        out.complete = !limited
        out.deviceID = PhoneCalendar.deviceID
        var containers: [CNContainer] = []
        do {
            containers = try store.containers(matching: nil)
        } catch {
            out.complete = false
        }
        for container in containers.sorted(by: { $0.identifier < $1.identifier }) {
            var entry = Centraid_Core_V1_PhoneContactContainer()
            entry.key = container.identifier
            entry.name = container.name
            out.containers.append(entry)
            let predicate = CNContact.predicateForContactsInContainer(withIdentifier: container.identifier)
            if !enumerate(store, predicate: predicate, container: container.identifier, into: &out.contacts) {
                out.complete = false
            }
        }
        return out
    }

    /// False when the container would not read: the read is then incomplete.
    private static func enumerate(
        _ store: CNContactStore,
        predicate: NSPredicate,
        container: String,
        into found: inout [Centraid_Core_V1_PhoneContact]
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
                var out = Centraid_Core_V1_PhoneContact()
                out.name = CNContactFormatter.string(from: contact, style: .fullName) ?? contact.organizationName
                out.phones = contact.phoneNumbers.map { $0.value.stringValue }
                out.emails = contact.emailAddresses.map { $0.value as String }
                out.birthday = monthDay(contact.birthday)
                // R-1127-10: the unified identifier means something on this device only.
                out.phoneID = "local:" + contact.identifier
                out.containerKey = container
                found.append(out)
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
/// system's sheet, and the OS's store-changed note brings the next read.
/// Before iOS 18 there is no limited access, so there is nothing to raise.
struct ContactAccessPickerHost: ViewModifier {
    @ObservedObject var shell: ShellModel

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.contactAccessPicker(isPresented: $shell.contactAccessPickerShown) { _ in }
        } else {
            content
        }
    }
}
