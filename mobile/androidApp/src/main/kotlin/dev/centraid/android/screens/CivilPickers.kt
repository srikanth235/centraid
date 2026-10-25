package dev.centraid.android.screens

import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.ui.window.Dialog
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.background
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.KitWords
import dev.centraid.android.theme.centraidColor

/**
 * THE OS PICKERS, BOUND TO CIVIL STRINGS. A machine speaks days as
 * `YYYY-MM-DD` and clocks as `HH:MM`; these dialogs read one in and hand one
 * back, and decide nothing else. The date picker speaks UTC-midnight millis
 * (Material's contract); the day is turned into and out of them by the shared
 * kit's civil arithmetic — a day number times a day's millis — so no
 * `Calendar`, no zone and no Gregorian cutover ever touches it (#1047).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CivilDateDialog(
    day: String,
    onPicked: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val picker = rememberDatePickerState(initialSelectedDateMillis = millisOfDay(day))
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            KitLink(label = KitWords.DONE, onClick = {
                val millis = picker.selectedDateMillis
                if (millis != null) onPicked(dayOfMillis(millis)) else onDismiss()
            })
        },
        dismissButton = { KitLink(label = KitWords.CANCEL, onClick = onDismiss) },
    ) {
        DatePicker(state = picker)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CivilTimeDialog(
    time: String,
    onPicked: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val parts = time.split(":")
    val picker = rememberTimePickerState(
        initialHour = parts.getOrNull(0)?.toIntOrNull()?.coerceIn(0, 23) ?: 9,
        initialMinute = parts.getOrNull(1)?.toIntOrNull()?.coerceIn(0, 59) ?: 0,
        is24Hour = true,
    )
    Dialog(onDismissRequest = onDismiss) {
        Column(Modifier.background(centraidColor("bg")).padding(16.dp)) {
            TimePicker(state = picker)
            Row {
                KitLink(label = KitWords.CANCEL, onClick = onDismiss)
                KitLink(label = KitWords.DONE, onClick = { onPicked(clock(picker.hour, picker.minute)) })
            }
        }
    }
}

private fun clock(hour: Int, minute: Int): String =
    hour.toString().padStart(2, '0') + ":" + minute.toString().padStart(2, '0')

private const val DAY_MILLIS: Long = 86_400_000L

/** `YYYY-MM-DD` as the picker's midnight millis (UTC, as the picker counts), or null for a day that is not one. */
internal fun millisOfDay(day: String): Long? = epochDayOf(day)?.let { it * DAY_MILLIS }

/** The picker's millis as `YYYY-MM-DD`: the day they fall in, counted in whole days. */
internal fun dayOfMillis(millis: Long): String = civilDayOf(Math.floorDiv(millis, DAY_MILLIS))

/**
 * Days since 1970-01-01 of a proleptic Gregorian `YYYY-MM-DD`, or null when it names no day
 * (Howard Hinnant's `days_from_civil`; the picker's own calendar arithmetic, no java.time below API 26).
 */
internal fun epochDayOf(day: String): Long? {
    val match = Regex("""^(\d{4})-(\d{2})-(\d{2})$""").matchEntire(day) ?: return null
    val (y0, m, d) = match.destructured.toList().map { it.toLong() }
    if (m !in 1..12 || d < 1 || d > daysIn(y0, m)) return null
    val y = if (m <= 2) y0 - 1 else y0
    val era = Math.floorDiv(y, 400L)
    val yoe = y - era * 400
    val doy = (153 * (if (m > 2) m - 3 else m + 9) + 2) / 5 + d - 1
    val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468
}

/** The `YYYY-MM-DD` of a count of days since 1970-01-01 (`civil_from_days`). */
internal fun civilDayOf(epochDay: Long): String {
    val z = epochDay + 719_468
    val era = Math.floorDiv(z, 146_097L)
    val doe = z - era * 146_097
    val yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
    val doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    val mp = (5 * doy + 2) / 153
    val d = doy - (153 * mp + 2) / 5 + 1
    val m = if (mp < 10) mp + 3 else mp - 9
    val y = yoe + era * 400 + if (m <= 2) 1 else 0
    return y.toString().padStart(4, '0') + "-" + m.toString().padStart(2, '0') + "-" + d.toString().padStart(2, '0')
}

private fun daysIn(year: Long, month: Long): Long = when (month) {
    2L -> if ((year % 4 == 0L && year % 100 != 0L) || year % 400 == 0L) 29 else 28
    4L, 6L, 9L, 11L -> 30
    else -> 31
}
