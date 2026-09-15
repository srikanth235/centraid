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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import centraid.screen.v1.Money
import dev.centraid.design.CentraidTokens
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

/** The token table in force. */
public val centraidTokens: NativeTheme
    @Composable @ReadOnlyComposable get() = LocalCentraidTokens.current

/** A colour role, in force. See [color] for why a missing role is loud. */
@Composable
@ReadOnlyComposable
public fun centraidColor(role: String): Color = LocalCentraidTokens.current.color(role)

/**
 * A SPACING RUNG, NEVER A TYPED-IN NUMBER.
 *
 * The rungs are 4/8/12/16/24/32; a value between them is a value nobody chose.
 */
@Composable
@ReadOnlyComposable
public fun centraidSpace(rung: String): Dp = requireNotNull(
    LocalCentraidTokens.current.spacing[rung],
) { "no such spacing rung '$rung'" }.dp

/** A radius, in force. */
@Composable
@ReadOnlyComposable
public fun centraidRadius(name: String): Dp = requireNotNull(
    LocalCentraidTokens.current.radii[name],
) { "no such radius '$name'" }.dp

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
        fontSize = style.fontSize.sp,
        lineHeight = style.lineHeight.sp,
        fontWeight = FontWeight(style.weight),
    )
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
 * core, and `Money.locale` is the vault's. This function reads them and
 * guesses nothing.
 */
public fun formatMoney(money: Money): String {
    if (money.currency.isEmpty()) return ""
    val locale = Locale.forLanguageTag(money.locale.ifEmpty { "und" })
    val format = NumberFormat.getCurrencyInstance(locale).apply {
        currency = java.util.Currency.getInstance(money.currency)
        minimumFractionDigits = money.exponent.toInt()
        maximumFractionDigits = money.exponent.toInt()
    }
    // `BigDecimal` and not a `Double`: a currency amount that went through a
    // binary float would be the rounding bug this whole comment is about.
    return format.format(BigDecimal(money.minor).movePointLeft(money.exponent.toInt()))
}
