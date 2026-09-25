package dev.centraid.shared

import com.lemonappdev.konsist.api.Konsist
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.shouldBe

/**
 * THE PER-APP LAYOUT, ENFORCED (#1025 S5, D-1025-S5-1).
 *
 * `commonMain` was one flat `screen/` package holding Home, the springboard
 * policy, the band, the vault roster, the gateway link, the mount AND the three
 * app machines. Nothing stopped Tally from reading Photos' state, and nothing
 * stopped the shell from reading either — so the layout said "these are all
 * screens" where the product says "one shell, many apps", and the difference
 * only shows up when somebody reaches across and nothing complains.
 *
 * The tree now mirrors the rest of the repository — one directory per app under
 * `crates/apps`, `copy` and `contracts/apps` — and these two rules are what make
 * the mirror load-bearing rather than decorative:
 *
 * 1. **An app knows no other app.** `apps.tally` importing `apps.photos` is a
 *    coupling nothing in the product justifies: two apps meet in the VAULT, as
 *    rows, and never in a reducer.
 * 2. **Nothing outside `apps` reaches into one.** The shell drives an app
 *    through the `screen` contract — [dev.centraid.shared.screen.ScreenMachine]
 *    and [dev.centraid.shared.screen.ScreenHost] — which is what lets a shell
 *    host a screen it knows nothing else about. A `shell/` file that imported
 *    `apps.tally.TallyListState` would be a shell that has to be edited to add
 *    an app.
 *
 * Konsist and not a reviewer, for the reason the platform-free rule gives: the
 * defect these prevent does not fail a build, it makes the next app's slice
 * bigger, and nobody sees that in a diff.
 */
class PerAppLayoutSpec : StringSpec({

    /** Every `commonMain` file, with the package it declares. */
    fun files() = Konsist.scopeFromDirectory("shared/src/commonMain").files

    val appsRoot = "dev.centraid.shared.apps"

    /** `dev.centraid.shared.apps.tally.Foo` -> `tally`. Null for anything else. */
    fun appOf(name: String?): String? = name
        ?.takeIf { it == appsRoot || it.startsWith("$appsRoot.") }
        ?.removePrefix(appsRoot)
        ?.removePrefix(".")
        ?.substringBefore('.')
        ?.takeIf { it.isNotEmpty() }

    "an apps.<x> package imports no other apps.<y>" {
        val offenders = mutableListOf<String>()
        files().forEach { file ->
            val mine = appOf(file.packagee?.name) ?: return@forEach
            file.imports.forEach { import ->
                val theirs = appOf(import.name)
                if (theirs != null && theirs != mine) {
                    offenders += "${file.name}: apps.$mine imports apps.$theirs (${import.name})"
                }
            }
        }
        // The failure message IS the finding, the same way the platform-free
        // rule's is: which app reached into which, and through what import.
        withClue(offenders) { offenders shouldBe emptyList() }
    }

    "nothing outside apps imports from inside it" {
        val offenders = mutableListOf<String>()
        files().forEach { file ->
            if (appOf(file.packagee?.name) != null) return@forEach
            file.imports.forEach { import ->
                if (appOf(import.name) != null) {
                    offenders += "${file.name}: ${file.packagee?.name} imports ${import.name}"
                }
            }
        }
        withClue(
            offenders.toString() +
                " — the shell drives an app through dev.centraid.shared.screen " +
                "(ScreenMachine/ScreenHost) and never by naming its types",
        ) { offenders shouldBe emptyList() }
    }

    "the kit names no app" {
        // The kit is shared by every app, so an import of one app from it is
        // the kit becoming that app's — and every other app then depends on
        // it. Rule two already forbids it (kit is outside `apps`); this names
        // the finding when it is the kit that reached.
        val offenders = files()
            .filter { it.packagee?.name?.startsWith("dev.centraid.shared.kit") == true }
            .flatMap { file -> file.imports.filter { appOf(it.name) != null }.map { "${file.name}: ${it.name}" } }
        withClue(offenders) { offenders shouldBe emptyList() }
    }

    "the layout these rules are about actually exists" {
        // A rule over a tree that moved is a rule that passes forever; the
        // platform-free spec learned that the hard way and asserts its scope
        // the same way. Here the assertion is stronger than a file count,
        // because the shape IS the deliverable: the packages are named.
        val packages = files().mapNotNull { it.packagee?.name }.toSet()
        withClue(packages) {
            listOf(
                "dev.centraid.shared.shell",
                "dev.centraid.shared.screen",
                "dev.centraid.shared.nav",
                "dev.centraid.shared.sync",
                "dev.centraid.shared.platform",
                "dev.centraid.shared.kit",
                "dev.centraid.shared.kit.time",
                "dev.centraid.shared.apps.tally",
                "dev.centraid.shared.apps.photos",
                "dev.centraid.shared.apps.notes",
                "dev.centraid.shared.apps.docs",
                "dev.centraid.shared.apps.people",
                "dev.centraid.shared.apps.tasks",
            ).all { packages.contains(it) }.shouldBeTrue()
        }
        // And `screen` is the CONTRACT and nothing else: two files, the machine
        // and the host. A screen that moved back into it would be a screen the
        // second rule above can no longer say anything about.
        files().filter { it.packagee?.name == "dev.centraid.shared.screen" }
            .map { it.name }.toSet() shouldBe setOf("ScreenMachine", "ScreenHost")
    }
})
