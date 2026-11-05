# Design source

[The mockups](mockups/README.md) define screen composition and interaction. [tokens.toml](tokens.toml) owns design values, including light/dark app accents, states, the eight list colors, surfaces, type, fonts, radii and spacing. A visual or UX change starts in the light mockup and updates tokens when a value changes.

Run `cargo xtask design` to generate the iOS asset catalog, Swift type/geometry tables, Android color/dimension resources and lookup tables, native kit words, brand icons, public-site values and dark mockups. The generator reads app manifests and [icons.json](icons.json) for the native catalog, and the Rust string catalogs for kit words and literal App Intents metadata. Run `bun run site:tokens` to copy the generated public-site sheet. Bun remains for the test kit and repository scripts; no TypeScript design package or native exporter remains.

`cargo xtask design --check` regenerates in memory and checks every expected file without changing it. Both PR and mobile JVM gates run this drift check. Before writing output, the generator checks app/state text and list-marker contrast, and rejects unknown literal typography or color roles in native Swift and Kotlin calls. Native role checks use the same token maps as the generated themes, including widget sources. Generated outputs must be committed with the source change.

Light mockups use semantic CSS variables from the generated `mockups/tokens.css`. Dark partners select the dark values and rewrite navigation to other dark screens. Photos, document artwork and white switch knobs keep their content colors. Never edit a dark mockup directly.

Behavioral contracts live in [product-intuition](../.claude/skills/product-intuition/references/screens-and-copy.md). Identity hashing, initials, imported-color mapping and figure tone live in the Rust design crate; shells receive finished keys and words.
