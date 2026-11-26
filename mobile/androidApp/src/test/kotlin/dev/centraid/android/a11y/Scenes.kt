package dev.centraid.android.a11y

import androidx.compose.runtime.Composable
import centraid.core.v1.PairLaptopState
import centraid.core.v1.Room
import centraid.core.v1.RoomBack
import centraid.core.v1.RoomBand
import centraid.core.v1.RoomBlock
import centraid.core.v1.RoomChoice
import centraid.core.v1.RoomChoiceStyle
import centraid.core.v1.RoomGlyph
import centraid.core.v1.RoomHeader
import centraid.core.v1.RoomKind
import centraid.core.v1.RoomOption
import centraid.core.v1.RoomReady
import centraid.core.v1.RoomRow
import centraid.core.v1.RoomSection
import centraid.core.v1.RoomTab
import centraid.core.v1.RoomTile
import centraid.core.v1.RoomTiles
import dev.centraid.android.room.RoomView
import dev.centraid.android.screens.pairing.PairLaptopPage

internal class Scene(val id: String, val app: String, val content: @Composable () -> Unit)

internal object Scenes {
    private val homeRoom = Room(
        kind = RoomKind.ROOM_KIND_HOME,
        key = "home",
        header_ = RoomHeader(title = "Centraid"),
        band = RoomBand(
            tabs = listOf(
                RoomTab(selector_id = "tab/home", label = "Home", icon = "Home", selected = true),
                RoomTab(selector_id = "tab/backup", label = "Backup", icon = "Backup", selected = false),
            ),
        ),
        ready = RoomReady(
            blocks = listOf(
                RoomBlock(
                    tiles = RoomTiles(
                        tiles = listOf(
                            RoomTile(selector_id = "tile/backup", label = "Backup", subtitle = "Backed up", glyph = RoomGlyph(icon = "Backup")),
                            RoomTile(selector_id = "tile/settings", label = "Settings", glyph = RoomGlyph(icon = "Settings")),
                        ),
                    ),
                ),
            ),
        ),
    )

    private val settingsRoom = Room(
        kind = RoomKind.ROOM_KIND_SYSTEM_PLACE,
        key = "settings",
        header_ = RoomHeader(
            title = "Settings",
            back = RoomBack(label = "Home", selector_id = "back"),
        ),
        ready = RoomReady(
            blocks = listOf(
                RoomBlock(
                    section = RoomSection(
                        selector_id = "section/appearance",
                        heading = "Appearance",
                        blocks = listOf(
                            RoomBlock(
                                choice = RoomChoice(
                                    selector_id = "choice/appearance",
                                    style = RoomChoiceStyle.ROOM_CHOICE_STYLE_SEGMENTED,
                                    options = listOf(
                                        RoomOption(id = "system", label = "System", selected = true),
                                        RoomOption(id = "light", label = "Light", selected = false),
                                        RoomOption(id = "dark", label = "Dark", selected = false),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        ),
    )

    private val backupRoom = Room(
        kind = RoomKind.ROOM_KIND_SYSTEM_PLACE,
        key = "backup",
        header_ = RoomHeader(title = "Backup"),
        ready = RoomReady(
            blocks = listOf(
                RoomBlock(
                    section = RoomSection(
                        selector_id = "section/line",
                        heading = "Backup",
                        blocks = listOf(
                            RoomBlock(row = RoomRow(selector_id = "row/line", title = "Backed up", meta = "2 minutes ago")),
                        ),
                    ),
                ),
            ),
        ),
    )

    private val pairWaiting = PairLaptopState(
        phase = PairLaptopState.Phase.PHASE_WAITING,
        title = "Pair a backup device",
        body = "Run this on the laptop, then scan or paste the code.",
        command = "centraid-gateway pair",
        scan_label = "Scan the code",
        payload_label = "Pairing code",
        primary_label = "Pair",
        primary_enabled = true,
        secondary_label = "Cancel",
    ).labelled()

    val all: List<Scene> = listOf(
        Scene("home", "home") { RoomView(homeRoom, {}, {}) },
        Scene("settings", "home") { RoomView(settingsRoom, {}, {}) },
        Scene("backup", "backup") { RoomView(backupRoom, {}, {}) },
        Scene("pair.laptop", "backup") { PairLaptopPage(pairWaiting, {}, {}) },
    )
}
