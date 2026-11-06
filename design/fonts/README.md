# Bundled typefaces

The redesign uses Geist (400, 600 and 700) and Geist Mono (400), following the committed mockups. The font families, PostScript names, weights and native resource names are values in [tokens.toml](../tokens.toml). `cargo xtask design` copies these files into both mobile apps and the public sites and emits their registration tables.

The static TTFs were instantiated from the upstream Google Fonts variable fonts at weights 400, 600 and 700 with FontTools 4.61.1. Their name tables identify each static face. No network font request is made by an app. Upstream sources: [Geist](https://github.com/google/fonts/tree/main/ofl/geist) and [Geist Mono](https://github.com/google/fonts/tree/main/ofl/geistmono). The accompanying OFL licenses apply to the font files.

The iOS registration tests check every emitted face, each type role, and scaling through the accessibility text sizes. Android resolves the generated resource names at compile time.
