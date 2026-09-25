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
import java.util.Calendar
import java.util.TimeZone

/**
 * THE OS PICKERS, BOUND TO CIVIL STRINGS. A machine speaks days as
 * `YYYY-MM-DD` and clocks as `HH:MM`; these dialogs read one in and hand one
 * back, and decide nothing else. The date picker works in UTC midnight
 * millis (Material's contract), so no zone ever shifts a day.
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

private val UTC: TimeZone = TimeZone.getTimeZone("UTC")

internal fun millisOfDay(day: String): Long? {
    val parts = day.split("-")
    if (parts.size != 3) return null
    val y = parts[0].toIntOrNull() ?: return null
    val m = parts[1].toIntOrNull() ?: return null
    val d = parts[2].toIntOrNull() ?: return null
    return Calendar.getInstance(UTC).apply {
        clear()
        set(y, m - 1, d)
    }.timeInMillis
}

internal fun dayOfMillis(millis: Long): String {
    val c = Calendar.getInstance(UTC).apply { timeInMillis = millis }
    return c.get(Calendar.YEAR).toString().padStart(4, '0') + "-" +
        (c.get(Calendar.MONTH) + 1).toString().padStart(2, '0') + "-" +
        c.get(Calendar.DAY_OF_MONTH).toString().padStart(2, '0')
}
