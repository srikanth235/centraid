package dev.centraid.shared

import dev.centraid.design.CentraidCatalog
import dev.centraid.shared.nav.AppHomes
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/**
 * THE ONE MAP FROM A DOMAIN TO THE APP A MEMBER OPENS IT IN (#1128, R-1128-7).
 *
 * `tasks` is a vault domain and a write app id, not an app a member launches;
 * every place that names or marks an app from an id asks [AppHomes], so a
 * folded domain never prints raw, never draws no mark and never sorts last.
 */
class AppHomesSpec : StringSpec({

    "tasks opens in Agenda and every launchable app opens in itself" {
        AppHomes.appOf("tasks") shouldBe "agenda"
        CentraidCatalog.apps.forEach { AppHomes.appOf(it.id) shouldBe it.id }
        AppHomes.appOf("") shouldBe ""
    }

    "a domain reads as its app's name, and an id the catalogue lacks as itself capitalised" {
        AppHomes.nameOf("tasks") shouldBe "Agenda"
        AppHomes.nameOf("agenda") shouldBe "Agenda"
        AppHomes.nameOf("weather") shouldBe "Weather"
        AppHomes.nameOf("") shouldBe ""
    }

    "the app a domain opens in is catalogued, so its name and mark exist" {
        CentraidCatalog.byId[AppHomes.appOf("tasks")]?.name shouldBe "Agenda"
        CentraidCatalog.byId.containsKey("tasks") shouldBe false
        AppHomes.isLaunchable("tasks") shouldBe false
        AppHomes.isLaunchable("agenda") shouldBe true
    }
})
