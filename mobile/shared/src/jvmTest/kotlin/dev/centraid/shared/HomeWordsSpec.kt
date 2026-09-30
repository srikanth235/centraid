package dev.centraid.shared

import dev.centraid.shared.shell.HomeWords
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

class HomeWordsSpec : StringSpec({
    "a switcher row names the vault, or says it has no name" {
        HomeWords.vaultName("Tahoe") shouldBe "Tahoe"
        HomeWords.vaultName("") shouldBe "Unnamed vault"
    }

    "the Forget alert names the vault it is about to delete" {
        HomeWords.forgetTitle("Tahoe") shouldBe "Forget Tahoe?"
        HomeWords.forgetTitle(" ") shouldBe "Forget this vault?"
    }
})
