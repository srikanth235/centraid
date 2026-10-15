import SwiftProtobuf
import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

/// MONEY, REGISTERED (#1099; K5). Its one line is in `AppRegistry.apps`.
///
/// Nine screens, one bridge each, held for the app's life (Tasks' shape):
/// `money.home` (Spending · Activity · Cash flow, More a sheet) and, pushed from
/// it, `money.transaction`, `money.target`, `money.recurring`, `money.import`,
/// `money.accounts`, `money.rules`, `money.categories` and `money.search`. The
/// Android twin is `screens/money/MoneyRoutes.kt`.
///
/// **A ROUTE'S PARAMETER NAMES WHAT THE SCREEN SHOWS** (`MoneyParameter`: the
/// transaction, the month and category of a plan, the pushing page's title for the
/// back control), plus a nonce that is unique to the push. `open` turns it into the
/// screen's own `Opened` event, with a fresh draft token, so the shell never
/// re-spells a parameter the proto already spells.
///
/// **THE HOME AND THE SEARCH OPEN ONCE PER PUSH.** `CentraidApp` sends a route's
/// `open` on every appearance, and a pop back onto the home from a pushed page is
/// one: its `Opened` resets the tab, the month and the filters the member chose
/// (Android opens on the push for the same reason). The nonce says "this push was
/// already opened", and `open` sends nothing for it. Every other screen re-reads
/// on a pop back: the import re-reads its accounts after "Add an account".
///
/// **INTENTS ARE THE SHELL'S.** A machine that emits the Plus, the search door, a
/// pick, a More row or Choose file changes nothing on it; `routeIntent` reads the
/// event the view just forwarded and pushes the destination. Choose file is the
/// import view's own (`.fileImporter`).
enum MoneyScreens: AppScreens {
    static let appID = "money"
    /// The machines' `SCREEN_ID`s.
    static let home = "money.home"
    static let transaction = "money.transaction"
    static let target = "money.target"
    static let recurring = "money.recurring"
    static let importer = "money.import"
    static let accounts = "money.accounts"
    static let rules = "money.rules"
    static let categories = "money.categories"
    static let search = "money.search"

    // MARK: - Routes

    /// The home, fresh: Spending, the current month, no filters.
    static func homeRoute() -> ShellModel.Route {
        .screen(home, MoneyParameter().encoded)
    }

    static func transactionRoute(_ txnID: String, parent: String) -> ShellModel.Route {
        .screen(transaction, MoneyParameter(parent: parent, txnID: txnID).encoded)
    }

    /// A category's plan for `month` (`YYYY-MM`), per the category line's `currency`.
    static func targetRoute(month: String, categoryID: String, currency: String) -> ShellModel.Route {
        .screen(target, MoneyParameter(month: month, categoryID: categoryID, currency: currency).encoded)
    }

    static func recurringRoute(parent: String) -> ShellModel.Route {
        .screen(recurring, MoneyParameter(parent: parent).encoded)
    }

    static func importRoute(parent: String) -> ShellModel.Route {
        .screen(importer, MoneyParameter(parent: parent).encoded)
    }

    static func accountsRoute(parent: String) -> ShellModel.Route {
        .screen(accounts, MoneyParameter(parent: parent).encoded)
    }

    static func rulesRoute(parent: String) -> ShellModel.Route {
        .screen(rules, MoneyParameter(parent: parent).encoded)
    }

    static func categoriesRoute(parent: String) -> ShellModel.Route {
        .screen(categories, MoneyParameter(parent: parent).encoded)
    }

    static func searchRoute() -> ShellModel.Route {
        .screen(search, MoneyParameter().encoded)
    }

    // MARK: - Registration

    @MainActor
    static func register(into shell: ShellModel) {
        var picked: (String, Data) -> Void = { _, _ in }
        #if canImport(CentraidShared)
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
        #endif

        let memory = MoneyOpenMemory()
        let deliver = picked
        for identifier in [home, transaction, target, recurring, importer, accounts, rules, categories, search] {
            shell.route(
                identifier,
                open: { [weak shell] parameter in opened(identifier, parameter, shell, memory) },
                view: { shell, parameter in view(identifier, shell, parameter, picked: deliver) }
            )
        }
    }

    /// EVERY OPEN IS THE ROUTE'S OWN `Opened`, with a draft token minted now.
    @MainActor
    private static func opened(_ identifier: String, _ parameter: Data, _ shell: ShellModel?, _ memory: MoneyOpenMemory) {
        guard let shell else { return }
        let route = MoneyParameter(decoding: parameter)
        let token = UUID().uuidString
        switch identifier {
        case home:
            guard memory.firstOpen(identifier, route.nonce) else { return }
            shell.send(screen: home, event: moneyEvent(Centraid_Screen_V1_MoneyHomeEvent.self) {
                $0.opened = .with { $0.destination = .spending }
            })
        case search:
            guard memory.firstOpen(identifier, route.nonce) else { return }
            shell.send(screen: search, event: moneyEvent(Centraid_Screen_V1_MoneySearchEvent.self) { $0.opened = .init() })
        case transaction:
            shell.send(screen: transaction, event: moneyEvent(Centraid_Screen_V1_MoneyTransactionEvent.self) {
                $0.opened = .with {
                    $0.txnID = route.txnID
                    $0.parent = route.parent
                    $0.draftToken = token
                }
            })
        case target:
            shell.send(screen: target, event: moneyEvent(Centraid_Screen_V1_MoneyTargetEvent.self) {
                $0.opened = .with {
                    $0.month = route.month
                    $0.categoryID = route.categoryID
                    $0.currency = route.currency
                    $0.draftToken = token
                }
            })
        case recurring:
            shell.send(screen: recurring, event: moneyEvent(Centraid_Screen_V1_MoneyRecurringEvent.self) {
                $0.opened = .with { $0.parent = route.parent }
            })
        case importer:
            shell.send(screen: importer, event: moneyEvent(Centraid_Screen_V1_MoneyImportEvent.self) {
                $0.opened = .with {
                    $0.parent = route.parent
                    $0.draftToken = token
                }
            })
        case accounts:
            shell.send(screen: accounts, event: moneyEvent(Centraid_Screen_V1_MoneyAccountsEvent.self) {
                $0.opened = .with {
                    $0.parent = route.parent
                    $0.draftToken = token
                }
            })
        case rules:
            shell.send(screen: rules, event: moneyEvent(Centraid_Screen_V1_MoneyRulesEvent.self) {
                $0.opened = .with {
                    $0.parent = route.parent
                    $0.draftToken = token
                }
            })
        case categories:
            shell.send(screen: categories, event: moneyEvent(Centraid_Screen_V1_MoneyCategoriesEvent.self) {
                $0.opened = .with {
                    $0.parent = route.parent
                    $0.draftToken = token
                }
            })
        default:
            break
        }
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

    @MainActor
    private static func decode<State: SwiftProtobuf.Message>(_ type: State.Type, _ shell: ShellModel, _ identifier: String) -> State {
        (try? State(serializedBytes: shell.state(identifier))) ?? State()
    }

    /// THE INTENTS, ROUTED. `parent` is the pushing page's own title, which the
    /// pushed page's back control says; empty reads "Money".
    @MainActor
    static func routeIntent(_ identifier: String, _ bytes: Data, _ shell: ShellModel) {
        switch identifier {
        case home:
            guard let event = try? Centraid_Screen_V1_MoneyHomeEvent(serializedBytes: bytes) else { return }
            let state = decode(Centraid_Screen_V1_MoneyHomeState.self, shell, home)
            let here = state.chrome.title
            switch event.kind {
            // The header's Plus and the day-one action: rows enter by import.
            case .add: shell.path.append(importRoute(parent: here))
            // The search bar is a door: Money's search is a page of its own.
            case .searchOpened: shell.path.append(searchRoute())
            case let .transaction(picked): shell.path.append(transactionRoute(picked.txnID, parent: here))
            case let .categoryLine(picked):
                shell.path.append(targetRoute(month: state.month, categoryID: picked.categoryID, currency: picked.currency))
            case .recurring: shell.path.append(recurringRoute(parent: here))
            case let .more(row):
                switch row.key {
                case "accounts": shell.path.append(accountsRoute(parent: here))
                case "rules": shell.path.append(rulesRoute(parent: here))
                case "categories": shell.path.append(categoriesRoute(parent: here))
                case "import": shell.path.append(importRoute(parent: here))
                default: break
                }
            default: break
            }
        case importer:
            guard let event = try? Centraid_Screen_V1_MoneyImportEvent(serializedBytes: bytes) else { return }
            switch event.kind {
            case .addAccount:
                let state = decode(Centraid_Screen_V1_MoneyImportState.self, shell, importer)
                shell.path.append(accountsRoute(parent: state.chrome.title))
            case .done:
                if !shell.path.isEmpty { shell.path.removeLast() }
            default: break
            }
        case search:
            if case let .transaction(picked)? = (try? Centraid_Screen_V1_MoneySearchEvent(serializedBytes: bytes))?.kind {
                let state = decode(Centraid_Screen_V1_MoneySearchState.self, shell, search)
                shell.path.append(transactionRoute(picked.txnID, parent: state.chrome.title))
            }
        default: break
        }
    }

    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? { homeRoute() }
}

/// WHAT A MONEY ROUTE CARRIES: the fields its screen's `Opened` names, and a
/// nonce that is unique to the push. JSON because a `Route` holds `Data`.
struct MoneyParameter: Codable, Hashable {
    var nonce: String = UUID().uuidString
    var parent: String = ""
    var txnID: String = ""
    var month: String = ""
    var categoryID: String = ""
    var currency: String = ""

    var encoded: Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(self)) ?? Data()
    }

    /// A parameter that did not decode names nothing and has no nonce, so it
    /// opens the screen on its defaults.
    init(decoding data: Data) {
        self = (try? JSONDecoder().decode(MoneyParameter.self, from: data)) ?? MoneyParameter(nonce: "")
    }

    init(
        nonce: String = UUID().uuidString,
        parent: String = "",
        txnID: String = "",
        month: String = "",
        categoryID: String = "",
        currency: String = ""
    ) {
        self.nonce = nonce
        self.parent = parent
        self.txnID = txnID
        self.month = month
        self.categoryID = categoryID
        self.currency = currency
    }
}

/// WHICH PUSH A SCREEN WAS LAST OPENED FOR. A class, so a route's `open` closure
/// holds it without crossing an actor.
final class MoneyOpenMemory {
    private var nonces: [String: String] = [:]

    /// True the first time `nonce` opens `identifier`; an empty nonce always opens.
    func firstOpen(_ identifier: String, _ nonce: String) -> Bool {
        if nonce.isEmpty { return true }
        if nonces[identifier] == nonce { return false }
        nonces[identifier] = nonce
        return true
    }
}
