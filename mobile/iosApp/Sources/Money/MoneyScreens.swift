import SwiftUI

import CentraidShared

/// MONEY, REGISTERED (#1099; K5). Its one line is in `AppRegistry.apps`.
///
/// Nine screens, one bridge each, held for the app's life (Tasks' shape):
/// `money.home` (Spending · Activity · Cash flow, More a sheet) and, pushed from
/// it, `money.transaction`, `money.target`, `money.recurring`, `money.import`,
/// `money.accounts`, `money.rules`, `money.categories` and `money.search`. The
/// Android twin is `screens/money/MoneyRoutes.kt`.
///
/// **A ROUTE'S PARAMETER IS ITS SCREEN'S `Opened` EVENT, AS THE SHARED SIDE
/// SPELLED IT** (`ScreenOpenings`), wrapped with a nonce unique to the push
/// (`OncePerPush`). `open` sends it through `MoneyRouting.opened`, which mints
/// the draft token the page's bridge would mint, so the shell never re-spells
/// a parameter the proto already spells.
///
/// **THE HOME AND THE SEARCH OPEN ONCE PER PUSH.** `CentraidApp` sends a route's
/// `open` on every appearance, and a pop back onto the home from a pushed page is
/// one: its `Opened` resets the tab, the month and the filters the member chose
/// (Android opens on the push for the same reason). The nonce says "this push was
/// already opened", and `open` sends nothing for it. Every other screen re-reads
/// on a pop back: the import re-reads its accounts after "Add an account".
///
/// **INTENTS ARE THE SHELL'S, AND WHERE THEY GO IS SHARED.** A machine that emits
/// the Plus, the search door, a pick, a More row, Add an account or Done changes
/// nothing on it; `send` hands the event to `MoneyRouting.route`, which answers
/// the move (Android applies the same one). Choose file is the import view's own
/// (`.fileImporter`).
enum MoneyScreens: AppScreens {
    static let appID = AppIds.shared.MONEY
    /// The machines' `SCREEN_ID`s.
    static let home = MoneyHomeMachine.shared.SCREEN_ID
    static let transaction = MoneyTransactionMachine.shared.SCREEN_ID
    static let target = MoneyTargetMachine.shared.SCREEN_ID
    static let recurring = MoneyRecurringMachine.shared.SCREEN_ID
    static let importer = MoneyImportMachine.shared.SCREEN_ID
    static let accounts = MoneyAccountsMachine.shared.SCREEN_ID
    static let rules = MoneyRulesMachine.shared.SCREEN_ID
    static let categories = MoneyCategoriesMachine.shared.SCREEN_ID
    static let search = MoneySearchMachine.shared.SCREEN_ID

    // MARK: - Registration

    @MainActor
    static func register(into shell: ShellModel) {
        var picked: (String, Data) -> Void = { _, _ in }
        // The no-argument constructors mint nothing: every `open` below spells
        // its own `Opened`, with its own draft token.
        let homeBridge = MoneyHomeBridge()
        let transactionBridge = MoneyTransactionBridge()
        let targetBridge = MoneyTargetBridge()
        let recurringBridge = MoneyRecurringBridge()
        let importBridge = MoneyImportBridge()
        let accountsBridge = MoneyAccountsBridge()
        let rulesBridge = MoneyRulesBridge()
        let categoriesBridge = MoneyCategoriesBridge()
        let searchBridge = MoneySearchBridge()
        shell.register(ScreenPort(
            id: home,
            send: { homeBridge.send(event: $0.kotlin) },
            attach: { homeBridge.attach(session: $0) },
            observe: { onState in homeBridge.observe { onState($0.data) } },
            departed: { homeBridge.departed() }
        ))
        shell.register(ScreenPort(
            id: transaction,
            send: { transactionBridge.send(event: $0.kotlin) },
            attach: { transactionBridge.attach(session: $0) },
            observe: { onState in transactionBridge.observe { onState($0.data) } },
            departed: { transactionBridge.departed() }
        ))
        shell.register(ScreenPort(
            id: target,
            send: { targetBridge.send(event: $0.kotlin) },
            attach: { targetBridge.attach(session: $0) },
            observe: { onState in targetBridge.observe { onState($0.data) } },
            departed: { targetBridge.departed() }
        ))
        shell.register(ScreenPort(
            id: recurring,
            send: { recurringBridge.send(event: $0.kotlin) },
            attach: { recurringBridge.attach(session: $0) },
            observe: { onState in recurringBridge.observe { onState($0.data) } },
            departed: { recurringBridge.departed() }
        ))
        shell.register(ScreenPort(
            id: importer,
            send: { importBridge.send(event: $0.kotlin) },
            attach: { importBridge.attach(session: $0) },
            observe: { onState in importBridge.observe { onState($0.data) } },
            departed: { importBridge.departed() }
        ))
        shell.register(ScreenPort(
            id: accounts,
            send: { accountsBridge.send(event: $0.kotlin) },
            attach: { accountsBridge.attach(session: $0) },
            observe: { onState in accountsBridge.observe { onState($0.data) } },
            departed: { accountsBridge.departed() }
        ))
        shell.register(ScreenPort(
            id: rules,
            send: { rulesBridge.send(event: $0.kotlin) },
            attach: { rulesBridge.attach(session: $0) },
            observe: { onState in rulesBridge.observe { onState($0.data) } },
            departed: { rulesBridge.departed() }
        ))
        shell.register(ScreenPort(
            id: categories,
            send: { categoriesBridge.send(event: $0.kotlin) },
            attach: { categoriesBridge.attach(session: $0) },
            observe: { onState in categoriesBridge.observe { onState($0.data) } },
            departed: { categoriesBridge.departed() }
        ))
        shell.register(ScreenPort(
            id: search,
            send: { searchBridge.send(event: $0.kotlin) },
            attach: { searchBridge.attach(session: $0) },
            observe: { onState in searchBridge.observe { onState($0.data) } },
            departed: { searchBridge.departed() }
        ))
        // THE OS PICKER'S FILE, as it was on disk, to the import's bridge.
        picked = { name, bytes in importBridge.picked(name: name, bytes: bytes.kotlin) }

        let memory = OpenMemory()
        let deliver = picked
        for identifier in [home, transaction, target, recurring, importer, accounts, rules, categories, search] {
            shell.route(
                identifier,
                open: { [weak shell] parameter in opened(identifier, parameter, shell, memory) },
                view: { shell, parameter in view(identifier, shell, parameter, picked: deliver) }
            )
        }
    }

    /// EVERY OPEN IS THE ROUTE'S OWN `Opened`, with a draft token minted now
    /// (`MoneyRouting.opened`); the home and the search once per push.
    @MainActor
    private static func opened(_ identifier: String, _ parameter: Data, _ shell: ShellModel?, _ memory: OpenMemory) {
        guard let shell, let route = OncePerPush(decoding: parameter) else { return }
        if identifier == home || identifier == search {
            guard memory.firstOpen(identifier, route.nonce) else { return }
        }
        shell.send(screen: identifier, event: MoneyRouting.shared.opened(screenId: identifier, opened: route.opened.kotlin).data)
    }

    // MARK: - Views

    @MainActor
    private static func view(
        _ identifier: String,
        _ shell: ShellModel,
        _ parameter: Data,
        picked: @escaping (String, Data) -> Void
    ) -> AnyView {
        let send: (Data) -> Void = { [weak shell] bytes in
            guard let shell else { return }
            shell.send(screen: identifier, event: bytes)
            routeIntent(identifier, bytes, shell)
        }
        let pop: () -> Void = { [weak shell] in
            guard let shell, !shell.path.isEmpty else { return }
            shell.path.removeLast()
        }
        switch identifier {
        case home:
            return AnyView(MoneyHomeView(
                data: shell.state(home),
                send: send,
                onHome: { [weak shell] in shell?.path.removeAll() }
            ))
        case transaction:
            return AnyView(MoneyTransactionView(data: shell.state(transaction), send: send, onBack: pop))
        case target:
            return AnyView(MoneyTargetView(data: shell.state(target), send: send, onBack: pop))
        case recurring:
            return AnyView(MoneyRecurringView(data: shell.state(recurring), send: send, onBack: pop))
        case importer:
            return AnyView(MoneyImportView(
                data: shell.state(importer),
                send: send,
                onPicked: picked,
                onBack: pop,
                onDeparted: { [weak shell] in shell?.departed(importer) }
            ))
        case accounts:
            return AnyView(MoneyAccountsView(data: shell.state(accounts), send: send, onBack: pop))
        case rules:
            return AnyView(MoneyRulesView(data: shell.state(rules), send: send, onBack: pop))
        case categories:
            return AnyView(MoneyCategoriesView(data: shell.state(categories), send: send, onBack: pop))
        case search:
            return AnyView(MoneySearchView(
                data: shell.state(search),
                send: send,
                onBack: pop,
                openContainer: { [weak shell] in shell?.openRow($0, parent: $1) }
            ))
        default:
            return AnyView(EmptyView())
        }
    }

    // MARK: - Intents

    /// THE INTENTS, ROUTED BY THE SHARED SIDE (`MoneyRouting`): which page an
    /// event opens — or that Done pops — is decided once, for both shells. This
    /// only applies it.
    @MainActor
    static func routeIntent(_ identifier: String, _ bytes: Data, _ shell: ShellModel) {
        shell.apply(MoneyRouting.shared.route(screenId: identifier, event: bytes.kotlin, state: shell.state(identifier).kotlin))
    }

    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? { .home(of: appID) }

    /// A SCREEN THE SHARED SIDE NAMED (`ScreenOpening`) is pushed in the shape
    /// this app's routes take: its event, as spelled, with a nonce for the push.
    static func present(_ screen: String, _ opened: Data) -> ShellModel.Route {
        .screen(screen, OncePerPush(opened: opened).encoded)
    }
}
