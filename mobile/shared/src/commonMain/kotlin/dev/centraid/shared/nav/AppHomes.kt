package dev.centraid.shared.nav

import dev.centraid.design.CentraidCatalog

/**
 * WHICH APP A MEMBER OPENS A DOMAIN IN (#1128, R-1128-7).
 *
 * The catalogue lists the apps a member LAUNCHES, and every id the vault or the
 * assistant names is one of them: no domain is folded into another app any more
 * (Tasks were folded into Agenda, and the `tasks` id is gone). The map is empty,
 * and a place that names or marks an app from an id still asks here so a domain
 * folded into an app later has one place to say so.
 */
public object AppHomes {
    /** The domain ids that are not an app of their own, with the app each opens in. */
    private val OPENS_IN: Map<String, String> = emptyMap()

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
