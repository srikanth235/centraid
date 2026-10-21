package dev.centraid.shared.nav

import dev.centraid.design.CentraidCatalog

/**
 * WHICH APP A MEMBER OPENS A DOMAIN IN (#1128, R-1128-7).
 *
 * The vault's write app ids and the assistant's card apps name DOMAINS
 * (`tasks`); the catalogue lists the apps a member LAUNCHES. They were the same
 * set until Tasks folded into Agenda, and they are one map now: a place that
 * names or marks an app from an id (a search group's header, a stranded write's
 * status line, a chat card's mark, an import's "Open ..." button) asks here, and
 * a place that ROUTES a row keeps the row's own id — a task row still opens
 * `TasksDetail` through [RowRoutes], whatever app header it sits under.
 *
 * A persisted id never goes through this map: a card's app stays `tasks` (the
 * card CHECK and `CARD_APPS` in the core name it), and only the words and marks
 * drawn from it follow the app. A chat's scope is an app, never a folded domain
 * (R-1128-F2): a visit to a task page scopes the chat to Agenda through
 * `ChatMachine.scopeOf`, which asks here.
 */
public object AppHomes {
    /** The domain ids that are not an app of their own, with the app each opens in. */
    private val OPENS_IN: Map<String, String> = mapOf(
        AppIds.TASKS to AppIds.AGENDA,
    )

    /** The app [appId] opens in: itself, unless it is a domain an app absorbed. */
    public fun appOf(appId: String): String = OPENS_IN[appId] ?: appId

    /** Is [appId] an app a member launches (a Home tile, an all-apps row), not a folded domain? */
    public fun isLaunchable(appId: String): Boolean = appOf(appId) == appId

    /**
     * The name a member reads for [appId]: its app's catalogue name, or the id
     * capitalised when the catalogue does not list it (a gateway app).
     */
    public fun nameOf(appId: String): String {
        val app = appOf(appId)
        return CentraidCatalog.byId[app]?.name ?: app.replaceFirstChar { it.uppercase() }
    }
}
