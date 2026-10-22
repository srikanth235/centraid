package dev.centraid.shared

import dev.centraid.design.CentraidCatalog
import dev.centraid.shared.nav.AppHomes
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/**
 * THE ONE MAP FROM A DOMAIN TO THE APP A MEMBER OPENS IT IN (#1128, R-1128-7).
 *
 * No domain is folded into another app any more: the tasks are Agenda's and the
 * `tasks` id is gone. Every place that names or marks an app from an id still
 * asks [AppHomes], so an id never prints raw and never draws no mark.
 */
class AppHomesSpec : StringSpec({

    "every launchable app opens in itself, and an id that is no app in itself too" {
        CentraidCatalog.apps.forEach { AppHomes.appOf(it.id) shouldBe it.id }
        AppHomes.appOf("tasks") shouldBe "tasks"
        AppHomes.appOf("") shouldBe ""
    }

    "an app reads as its catalogue name, and an id the catalogue lacks as itself capitalised" {
        AppHomes.nameOf("agenda") shouldBe "Agenda"
        AppHomes.nameOf("weather") shouldBe "Weather"
        AppHomes.nameOf("") shouldBe ""
    }

    "the catalogue has no `tasks` app" {
        CentraidCatalog.byId.containsKey("tasks") shouldBe false
        AppHomes.isLaunchable("agenda") shouldBe true
    }
})
