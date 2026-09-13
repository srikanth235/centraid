package dev.centraid.android

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Home: the floor of the one root stack. Covers open over it. */
@Composable
public fun HomeScreen(
    onOpenTally: () -> Unit,
    onOpenPhotos: () -> Unit,
    onOpenNotes: () -> Unit,
    currentName: String,
) {
    Column(modifier = Modifier.padding(16.dp)) {
        Text(text = "Centraid")
        Text(text = currentName)
        Button(onClick = onOpenTally) { Text("Tally") }
        Button(onClick = onOpenPhotos) { Text("Photos") }
        Button(onClick = onOpenNotes) { Text("Notes") }
    }
}
