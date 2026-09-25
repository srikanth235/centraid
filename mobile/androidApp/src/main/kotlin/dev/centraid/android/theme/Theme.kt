package dev.centraid.android.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import centraid.screen.v1.Money
import dev.centraid.android.R
import dev.centraid.design.CentraidTokens
import dev.centraid.design.NATIVE_TYPE_FACES
import dev.centraid.design.NativeTheme
import java.math.BigDecimal
import java.text.NumberFormat
import java.util.Locale

/**
 * Material 3 over the GENERATED token table (#1020, D-1020-E6).
 *
 * The mapping from Centraid's roles to Material's slots is hand-written and
 * belongs here; the VALUES are not. `dev.centraid.design.CentraidTokens` is
 * emitted by `contracts/tools/export-native-theme.ts` from `packages/design`,
 * and `git diff --exit-code design copy mobile` in the `mobile-jvm` gate step
 * is what stops it drifting.
 */
@Composable
public fun CentraidTheme(content: @Composable () -> Unit) {
    val tokens = if (isSystemInDarkTheme()) CentraidTokens.dark else CentraidTokens.light
    CompositionLocalProvider(LocalCentraidTokens provides tokens) {
        MaterialTheme(
            colorScheme = if (tokens.scheme == "dark") {
                darkColorScheme(
                    primary = tokens.color("accent"),
                    onPrimary = tokens.color("accentText"),
                    background = tokens.color("bg"),
                    surface = tokens.color("bgElev"),
                    onSurface = tokens.color("text"),
                    error = tokens.color("danger"),
                )
            } else {
                lightColorScheme(
                    primary = tokens.color("accent"),
                    onPrimary = tokens.color("accentText"),
                    background = tokens.color("bg"),
                    surface = tokens.color("bgElev"),
                    onSurface = tokens.color("text"),
                    error = tokens.color("danger"),
                )
            },
            content = content,
        )
    }
}

/**
 * The whole emitted table, reachable from any composable.
 *
 * Material's `ColorScheme` carries five of fifty-one roles, and Home needs
 * `bgElev`, `line`, `textFaint`, `skel` and a type rung Material has no slot
 * for at all. Widening the Material mapping to smuggle them through would be a
 * mapping that lies about what a Material slot means, so the table itself is
 * what crosses.
 *
 * `staticCompositionLocalOf`: the theme changes only with the system scheme, so
 * a read is not worth recomposition tracking.
 */
public val LocalCentraidTokens: androidx.compose.runtime.ProvidableCompositionLocal<NativeTheme> =
    staticCompositionLocalOf { CentraidTokens.light }

/** A colour role, in force. See [color] for why a missing role is loud. */
@Composable
@ReadOnlyComposable
public fun centraidColor(role: String): Color = LocalCentraidTokens.current.color(role)

/**
 * A TYPE ROLE, WITH ITS OWN LINE HEIGHT.
 *
 * The emitted table carries the line height beside the size because the
 * hand-off specifies both, and a rung rendered at the platform's default
 * leading is a rung at the wrong measure — most visible on the tile bodies,
 * where three stacked lines drift a whole row out of alignment.
 */
@Composable
@ReadOnlyComposable
public fun centraidType(role: String): TextStyle {
    val style = requireNotNull(LocalCentraidTokens.current.type[role]) {
        "no such type role '$role' in the emitted native theme. Roles come from " +
            "packages/design; regenerate with " +
            "`bun contracts/tools/export-native-theme.ts`."
    }
    return TextStyle(
        fontFamily = if (style.family == "code") FontFamily.Monospace else CentraidSans,
        fontSize = style.fontSize.sp,
        lineHeight = style.lineHeight.sp,
        fontWeight = FontWeight(style.weight),
        // A LINE HEIGHT COMPOSE WOULD OTHERWISE REFUSE TO APPLY TO ONE LINE.
        //
        // By default Compose TRIMS the leading above the first line and below
        // the last, so a single-line `Text` at a 15/22 rung stands at the face's
        // natural height and not at 22 — and a three-line one occupies
        // 22+22+natural rather than 66. Rows that are supposed to sit on a
        // common pitch then do not, which is exactly the defect SwiftUI had on
        // the other shell until `CentraidTypeModifier` was fixed: same class,
        // opposite cause (there the leading was never added, here it is added
        // and then trimmed away).
        //
        // `Trim.None` keeps both halves and `Alignment.Center` splits the
        // surplus evenly above and below, which is what the CSS line box the
        // token is copied from does. `includeFontPadding = false` drops
        // Android's legacy extra padding on top of that — it is a pre-Compose
        // compatibility affordance whose size depends on the FACE, so leaving it
        // on would make Instrument Sans and Roboto measure differently for
        // reasons no token describes.
        lineHeightStyle = LineHeightStyle(
            alignment = LineHeightStyle.Alignment.Center,
            trim = LineHeightStyle.Trim.None,
        ),
        platformStyle = PlatformTextStyle(includeFontPadding = false),
    )
}

/**
 * INSTRUMENT SANS, BUILT ONCE.
 *
 * Every type token says `family: "sans"` and this shell has never drawn it:
 * with no `fontFamily`, Compose renders Roboto, and nothing about that is an
 * error — which is how it went unnoticed for the project's whole life. The
 * files come from `packages/design/fonts`, the one source, copied into
 * `res/font` by `contracts/tools/export-native-theme.ts`.
 *
 * A `val` and not an expression inside [centraidType]: `FontFamily(...)` builds
 * a new instance per call, and a new instance is a new cache key for Compose's
 * font resolver, so a per-call family would re-resolve the face on every
 * recomposition of every label.
 *
 * THE `R.font` IDS CANNOT BE EMITTED — Kotlin has no way to turn the string
 * `"instrument_sans_book"` into an `R` id without reflection. So the emitted
 * [NATIVE_TYPE_FACES] table carries the NAMES and [CentraidSansFaces] is what a
 * reader compares these two references against; a face renamed upstream changes
 * that table and the resource file together, and this file stops compiling.
 *
 * `W400` IS BOUND TO `instrument_sans_book`, WHICH IS A 470, AND THAT IS THE
 * WHOLE POINT. It is a lowering and not a third weight: the ramp says 400, this
 * shell's `FontWeight` says `W400`, and only the bytes behind that rung differ
 * from the web's. The touch step [NativeTheme] already carries scales the glyph
 * without scaling the stroke, so a true 400 reads thin in the hand — see
 * `docs/decisions.md`. Declaring the file at `W400` rather than at some
 * invented `W470` is also what stops Compose from synthesising anything: the
 * resolver is asked for the weight it is handed, and it finds an exact face.
 */
private val CentraidSans: FontFamily = FontFamily(
    Font(R.font.instrument_sans_book, FontWeight.W400),
    Font(R.font.instrument_sans_semibold, FontWeight.W600),
)

/**
 * The emitted resource names this file's `R.font` references stand for.
 *
 * `androidApp` has no unit-test source set, so THE RESOURCE COMPILE IS THE
 * GUARD: `aapt2` fails the build outright if `res/font/instrument_sans_*.ttf`
 * is missing or misnamed, and `R.font.instrument_sans_book` above does not
 * resolve. This value is the readable half — it names the emitted rows so a
 * reader can see which `packages/design` fact the ids above are bound to.
 */
internal val CentraidSansFaces: Map<Int, String> =
    requireNotNull(NATIVE_TYPE_FACES["sans"]) {
        "the emitted face table has no 'sans' family; regenerate with " +
            "`bun contracts/tools/export-native-theme.ts`."
    }

/**
 * A role, or a loud failure.
 *
 * `requireNotNull` and not a fallback colour: a role that has been renamed in
 * `packages/design` and not here would otherwise paint something plausible and
 * wrong, and the emitted `NATIVE_COLOR_ROLES` list is what a test checks this
 * against.
 */
internal fun NativeTheme.color(role: String): Color = Color(
    requireNotNull(colors[role]) {
        "no such colour role '$role' in the emitted native theme. Roles come from " +
            "packages/design; regenerate with " +
            "`bun contracts/tools/export-native-theme.ts`."
    },
)

/**
 * MONEY, WITH THE VAULT'S LOCALE AND THE CURRENCY'S OWN EXPONENT.
 *
 * v0's formatter is wrong in two ways at once
 * (`packages/design/src/format.ts:38`, `:49`; census §E8): it divides minor
 * units by 100 UNCONDITIONALLY, so JPY is rendered a hundred times too small
 * and BHD ten times too large, and it calls
 * `new Intl.NumberFormat(undefined, …)` — the HOST's locale — so the same vault
 * renders differently on two devices.
 *
 * Both come from the message rather than from this function: `Money.exponent`
 * is the currency's own minor-unit exponent, from the kit's table through the
 * core, and `Money.locale` is the vault's — or empty, which is the device's.
 * This function reads them and guesses nothing else.
 */
public fun formatMoney(money: Money): String {
    if (money.currency.isEmpty()) return ""
    val exponent = money.exponent.toInt()
    // AN EMPTY LOCALE IS THE DEVICE'S, as on iOS (`Money.render`) and as
    // `TallyReads` says: "und" was the ROOT locale — no grouping a member
    // recognises and a bare currency sign — so the two shells drew one amount
    // two ways (`contracts/screens/money-render.json`).
    val locale = if (money.locale.isEmpty()) Locale.getDefault() else Locale.forLanguageTag(money.locale)
    // `BigDecimal` and not a `Double`: a currency amount that went through a
    // binary float would be the rounding bug this whole comment is about.
    val amount = BigDecimal(money.minor).movePointLeft(exponent)
    // A CODE ISO 4217 DOES NOT KNOW IS SPELLED, NOT A CRASH. The schema takes
    // any three letters and `Currency.getInstance` throws on one it has never
    // heard of, which took a whole ledger row down with it. The amount beside
    // its own code is what the row actually says — and what iOS draws.
    val currency = runCatching { java.util.Currency.getInstance(money.currency) }.getOrNull()
        ?: return NumberFormat.getNumberInstance(locale).apply {
            minimumFractionDigits = exponent
            maximumFractionDigits = exponent
        }.format(amount) + " " + money.currency
    val format = NumberFormat.getCurrencyInstance(locale).apply {
        this.currency = currency
        minimumFractionDigits = exponent
        maximumFractionDigits = exponent
    }
    return format.format(amount)
}
