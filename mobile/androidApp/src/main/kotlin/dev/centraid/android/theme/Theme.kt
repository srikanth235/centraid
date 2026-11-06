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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.centraid.android.kit.Money
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
 * emitted by `cargo xtask design` from `design/tokens.toml`,
 * and `git diff --exit-code design copy mobile` in the `mobile-jvm` gate step
 * is what stops it drifting.
 */
@Composable
public fun CentraidTheme(
    /** THE MEMBER'S APPEARANCE (R-CHROME-7), resolved; the phone's by default. */
    dark: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val tokens = if (dark) CentraidTokens.dark else CentraidTokens.light
    // Preserve the system's complete accessibility font scale (#1173).
    CompositionLocalProvider(LocalCentraidTokens provides tokens) {
        MaterialTheme(
            colorScheme = if (tokens.scheme == "dark") {
                darkColorScheme(
                    primary = tokens.color("accent"),
                    onPrimary = tokens.color("onAccent"),
                    background = tokens.color("bg"),
                    surface = tokens.color("bgElev"),
                    onSurface = tokens.color("text"),
                    error = tokens.color("danger"),
                )
            } else {
                lightColorScheme(
                    primary = tokens.color("accent"),
                    onPrimary = tokens.color("onAccent"),
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
 * `staticCompositionLocalOf`: the theme changes only with the scheme, so a
 * read is not worth recomposition tracking.
 */
public val LocalCentraidTokens: androidx.compose.runtime.ProvidableCompositionLocal<NativeTheme> =
    staticCompositionLocalOf { CentraidTokens.light }

/**
 * WHETHER THE SCREEN IS DRAWN DARK — the scheme in force, which is the
 * member's appearance (R-CHROME-7) and not necessarily the phone's. Read this,
 * never `isSystemInDarkTheme()`, which would answer for the phone alone.
 */
@Composable
@ReadOnlyComposable
public fun centraidDark(): Boolean = LocalCentraidTokens.current.scheme == "dark"

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
 *
 * Every role follows the complete system font scale. Explicit `scales = false`
 * is reserved for decorative marks, never navigation or reading text.
 */
@Composable
@ReadOnlyComposable
public fun centraidType(role: String, scales: Boolean = true): TextStyle {
    val style = requireNotNull(LocalCentraidTokens.current.type[role]) {
        "no such type role '$role' in the emitted native theme. Roles come from " +
            "design/tokens.toml; regenerate with " +
            "`cargo xtask design`."
    }
    // `Dp.toSp()` against the density in force is the `sp` that draws as that
    // many `dp` whatever the font scale (and its nonlinear curve) is, which is
    // what a held role needs; `size / fontScale` would be wrong off the linear
    // part of the curve.
    val holds = !scales
    val density = LocalDensity.current
    val fontSize = if (holds) with(density) { style.fontSize.dp.toSp() } else style.fontSize.sp
    val lineHeight = if (holds) with(density) { style.lineHeight.dp.toSp() } else style.lineHeight.sp
    return TextStyle(
        fontFamily = if (style.family == "code") CentraidMono else CentraidSans,
        fontSize = fontSize,
        lineHeight = lineHeight,
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
        // on would make Geist and Roboto measure differently for
        // reasons no token describes.
        lineHeightStyle = LineHeightStyle(
            alignment = LineHeightStyle.Alignment.Center,
            trim = LineHeightStyle.Trim.None,
        ),
        platformStyle = PlatformTextStyle(includeFontPadding = false),
    )
}

/** Geist faces emitted from design/fonts; resource compilation verifies the names. */
private val CentraidSans: FontFamily = FontFamily(
    Font(R.font.geist_regular, FontWeight.W400),
    Font(R.font.geist_semibold, FontWeight.W600),
    Font(R.font.geist_bold, FontWeight.W700),
)

private val CentraidMono: FontFamily = FontFamily(Font(R.font.geist_mono_regular, FontWeight.W400))

/**
 * The emitted resource names this file's `R.font` references stand for.
 *
 * `androidApp` has no unit-test source set, so THE RESOURCE COMPILE IS THE
 * GUARD: `aapt2` fails the build outright if `res/font/geist_*.ttf`
 * is missing or misnamed, and `R.font.geist_regular` above does not
 * resolve. This value is the readable half — it names the emitted rows so a
 * reader can see which `design/tokens.toml` fact the ids above are bound to.
 */
internal val CentraidSansFaces: Map<Int, String> =
    requireNotNull(NATIVE_TYPE_FACES["sans"]) {
        "the emitted face table has no 'sans' family; regenerate with " +
            "`cargo xtask design`."
    }

/**
 * A role, or a loud failure.
 *
 * `requireNotNull` and not a fallback colour: a role that has been renamed in
 * `design/tokens.toml` and not here would otherwise paint something plausible and
 * wrong, and the emitted `NATIVE_COLOR_ROLES` list is what a test checks this
 * against.
 */
internal fun NativeTheme.color(role: String): Color = Color(
    requireNotNull(colors[role]) {
        "no such colour role '$role' in the emitted native theme. Roles come from " +
            "design/tokens.toml; regenerate with " +
            "`cargo xtask design`."
    },
)

/**
 * MONEY, WITH THE VAULT'S LOCALE AND THE CURRENCY'S OWN EXPONENT.
 *
 * v0's formatter is wrong in two ways at once
 * (`design/tokens.toml/src/format.ts:38`, `:49`; census §E8): it divides minor
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
    val exponent = money.exponent
    // AN EMPTY LOCALE IS THE DEVICE'S, as in the Rust formatter and as
    // the retired Tally reads said: "und" was the ROOT locale — no grouping a member
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
