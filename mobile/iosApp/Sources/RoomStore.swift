import Combine
import Foundation
import SwiftUI

@MainActor
final class RoomStore: ObservableObject {
    @Published private(set) var activeTab: String = RustScreens.homeTab
    @Published private(set) var stacks: [String: [Centraid_Core_V1_RoomShown]] = [:]
    @Published private(set) var sheet: Centraid_Core_V1_RoomShown?
    @Published private(set) var stage: Centraid_Core_V1_RoomShown?
    @Published private(set) var lastTransition: Centraid_Core_V1_RoomTransition = .unspecified

    var onAppearanceChanged: ((ColorScheme?) -> Void)?

    private let core: any ScreenCore
    private var pumpTask: Task<Void, Never>?
    private var started = false

    init(core: any ScreenCore) {
        self.core = core
    }

    var currentStack: [Centraid_Core_V1_RoomShown] {
        stacks[activeTab] ?? []
    }

    var topRoom: Centraid_Core_V1_RoomShown? {
        currentStack.last
    }

    func start() async {
        guard !started else { return }
        started = true
        let stream = core.roomUpdates
        pumpTask = Task { [weak self] in
            for await shown in stream {
                if Task.isCancelled { break }
                self?.apply(shown)
            }
        }
        await refreshAppearance()
        await drainShareInbox()
        await TodayGlanceWriter.sync(rooms: self)
        await open(key: "home", tab: RustScreens.homeTab, root: true)
    }

    func stop() {
        pumpTask?.cancel()
        pumpTask = nil
    }

    func open(key: String, tab: String = RustScreens.homeTab, root: Bool = false) async {
        var open = Centraid_Core_V1_RoomOpen()
        open.key = key
        open.tab = tab
        open.root = root
        var roomReq = Centraid_Core_V1_RoomRequest()
        roomReq.kind = .open(open)
        await sendRoomRequest(roomReq)
    }

    func send(instance: UInt64, event: Centraid_Core_V1_RoomEvent.OneOf_Kind) {
        var roomEvent = Centraid_Core_V1_RoomEvent()
        roomEvent.kind = event
        var send = Centraid_Core_V1_RoomSend()
        send.instance = instance
        send.event = roomEvent
        var roomReq = Centraid_Core_V1_RoomRequest()
        roomReq.kind = .send(send)
        Task { [weak self] in
            await self?.sendRoomRequest(roomReq)
        }
    }

    func tap(instance: UInt64, selectorID: String) {
        guard !selectorID.isEmpty else { return }
        var tap = Centraid_Core_V1_RoomTap()
        tap.selectorID = selectorID
        send(instance: instance, event: .tap(tap))
    }

    func change(
        instance: UInt64,
        selectorID: String,
        seq: UInt64,
        value: Centraid_Core_V1_RoomChange.OneOf_Value
    ) {
        guard !selectorID.isEmpty else { return }
        var change = Centraid_Core_V1_RoomChange()
        change.selectorID = selectorID
        change.seq = seq
        change.value = value
        send(instance: instance, event: .change(change))
    }

    func scrolled(instance: UInt64, anchorSelectorID: String, anchorFractionMilli: UInt32) {
        guard !anchorSelectorID.isEmpty else { return }
        var scrolled = Centraid_Core_V1_RoomScrolled()
        scrolled.anchorSelectorID = anchorSelectorID
        scrolled.anchorFractionMilli = min(anchorFractionMilli, 999)
        send(instance: instance, event: .scrolled(scrolled))
    }

    func sendCanvas(instance: UInt64, event: Centraid_Core_V1_RoomCanvasEvent) {
        guard !event.selectorID.isEmpty else { return }
        send(instance: instance, event: .canvas(event))
    }

    func canvas(instance: UInt64, selectorID: String, kind: Centraid_Core_V1_RoomCanvasEvent.OneOf_Kind) {
        var canvasEvent = Centraid_Core_V1_RoomCanvasEvent()
        canvasEvent.selectorID = selectorID
        canvasEvent.kind = kind
        sendCanvas(instance: instance, event: canvasEvent)
    }

    func dismissSheet() {
        guard let openSheet = sheet else { return }
        if openSheet.room.header.hasBack, !openSheet.room.header.back.selectorID.isEmpty {
            tap(instance: openSheet.instance, selectorID: openSheet.room.header.back.selectorID)
        }
        sheet = nil
    }

    func dismissStage() {
        guard let openStage = stage else { return }
        if openStage.room.header.hasBack, !openStage.room.header.back.selectorID.isEmpty {
            tap(instance: openStage.instance, selectorID: openStage.room.header.back.selectorID)
        }
        stage = nil
    }

    func deviceGet(_ key: String) async -> String? {
        var get = Centraid_Core_V1_DeviceGet()
        get.key = key
        var device = Centraid_Core_V1_DeviceRequest()
        device.kind = .get(get)
        var request = Centraid_Core_V1_Request()
        request.kind = .device(device)
        guard let response = try? await core.call(request),
              case .device(let answer)? = response.kind,
              answer.found
        else { return nil }
        return answer.value
    }

    @discardableResult
    func devicePut(_ key: String, value: String) async -> Bool {
        var put = Centraid_Core_V1_DevicePut()
        put.key = key
        put.value = value
        var device = Centraid_Core_V1_DeviceRequest()
        device.kind = .put(put)
        var request = Centraid_Core_V1_Request()
        request.kind = .device(device)
        guard let response = try? await core.call(request),
              case .device? = response.kind
        else { return false }
        return true
    }

    @discardableResult
    func deviceDelete(_ key: String) async -> Bool {
        var del = Centraid_Core_V1_DeviceDelete()
        del.key = key
        var device = Centraid_Core_V1_DeviceRequest()
        device.kind = .delete(del)
        var request = Centraid_Core_V1_Request()
        request.kind = .device(device)
        guard let response = try? await core.call(request),
              case .device? = response.kind
        else { return false }
        return true
    }

    func refreshAppearance() async {
        guard let raw = await deviceGet("settings.appearance") else { return }
        let scheme = Self.parseAppearance(raw)
        onAppearanceChanged?(scheme)
    }

    @discardableResult
    func drainShareInbox(inboxURL: URL? = ShareInboxWriter.inboxDirectoryURL()) async -> [Centraid_Core_V1_ShareInItem] {
        guard let inboxURL, ShareInboxWriter.hasPendingItems(in: inboxURL) else { return [] }
        var shareIn = Centraid_Core_V1_ShareInRequest()
        shareIn.inboxDir = inboxURL.path
        var request = Centraid_Core_V1_Request()
        request.kind = .shareIn(shareIn)
        guard let response = try? await core.call(request),
              case .shareIn(let answer)? = response.kind
        else { return [] }
        return answer.items
    }

    static func parseAppearance(_ raw: String) -> ColorScheme? {
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = object["value"] as? String
        else { return nil }
        switch value {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }

    private func sendRoomRequest(_ roomReq: Centraid_Core_V1_RoomRequest) async {
        var request = Centraid_Core_V1_Request()
        request.kind = .room(roomReq)
        guard let response = try? await core.call(request),
              case .room(let answer)? = response.kind
        else { return }
        for shown in answer.shown {
            apply(shown)
        }
    }

    func apply(_ shown: Centraid_Core_V1_RoomShown) {
        let tab = shown.tab.isEmpty ? activeTab : shown.tab
        lastTransition = shown.transition

        switch shown.transition {
        case .reload:
            if sheet?.instance == shown.instance {
                sheet = shown
            } else if stage?.instance == shown.instance {
                stage = shown
            } else if var stack = stacks[tab],
                      let idx = stack.lastIndex(where: { $0.instance == shown.instance }) {
                stack[idx] = shown
                stacks[tab] = stack
            }
            if shown.room.key == "settings" {
                Task { [weak self] in await self?.refreshAppearance() }
            }

        case .push:
            activeTab = tab
            if shown.room.kind == .sheet {
                sheet = shown
            } else if shown.room.kind == .stage {
                stage = shown
            } else {
                var stack = stacks[tab] ?? []
                if let idx = stack.lastIndex(where: { $0.instance == shown.instance }) {
                    stack[idx] = shown
                } else {
                    stack.append(shown)
                }
                stacks[tab] = stack
            }

        case .pop:
            activeTab = tab
            if sheet != nil && shown.room.kind != .sheet {
                sheet = nil
            }
            if stage != nil && shown.room.kind != .stage {
                stage = nil
            }
            var stack = stacks[tab] ?? []
            let targetDepth = max(Int(shown.depth), 1)
            if stack.count > targetDepth {
                stack = Array(stack.prefix(targetDepth))
            }
            if stack.isEmpty {
                stack = [shown]
            } else {
                stack[stack.count - 1] = shown
            }
            stacks[tab] = stack

        case .replace, .unspecified, .UNRECOGNIZED:
            activeTab = tab
            sheet = nil
            stage = nil
            stacks[tab] = [shown]
        }
    }
}
