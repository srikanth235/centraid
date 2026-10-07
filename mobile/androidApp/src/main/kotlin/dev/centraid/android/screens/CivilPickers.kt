package dev.centraid.android.screens

import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import dev.centraid.android.kit.KitWords
import dev.centraid.android.theme.centraidColor
import dev.centraid.shared.kit.time.civilDayOf
import dev.centraid.shared.kit.time.epochDayOf
import dev.centraid.shared.kit.time.floorDiv

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
            TextButton(onClick = {
                val millis = picker.selectedDateMillis
                if (millis != null) onPicked(dayOfMillis(millis)) else onDismiss()
            }) { Text(KitWords.DONE) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(KitWords.CANCEL) } },
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
                TextButton(onClick = onDismiss) { Text(KitWords.CANCEL) }
                TextButton(onClick = { onPicked(clock(picker.hour, picker.minute)) }) { Text(KitWords.DONE) }
            }
        }
    }
}

private fun clock(hour: Int, minute: Int): String =
    hour.toString().padStart(2, '0') + ":" + minute.toString().padStart(2, '0')

private const val DAY_MILLIS: Long = 86_400_000L

/** `YYYY-MM-DD` as the picker's midnight millis, or null for a day that is not one. */
internal fun millisOfDay(day: String): Long? = epochDayOf(day)?.let { it * DAY_MILLIS }

/** The picker's millis as `YYYY-MM-DD`: the day they fall in, counted in whole days. */
internal fun dayOfMillis(millis: Long): String = civilDayOf(floorDiv(millis, DAY_MILLIS))
