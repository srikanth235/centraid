package dev.centraid.shared.apps.photos

import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotoLabel
import centraid.screen.v1.PhotoPerson
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PhotoStateView
import centraid.screen.v1.PhotosSearchEvent
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SearchHits
import centraid.screen.v1.SearchMatch
import centraid.screen.v1.SearchResting
import centraid.screen.v1.SearchTopHit
import dev.centraid.shared.sync.LinkConditions
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * WHAT SEARCH READS, AND WHAT IT MAKES OF THE ROWS (#1029, the photos port).
 *
 * v0's `search-hits.ts` is the spec: a query reaches **people** (confirmed
 * parties), **places** (the member's name, the gazetteer's, and the home band),
 * **albums**, **labels** (concepts tagged on a photograph) and **captions**, and
 * the answer is two things — the people, places and albums it NAMED, as doors
 * above the grid, and the photographs all of them REACH, as the grid. Typing
 * "Tahoe" returns the album's photographs, not an empty grid under a row
 * saying the album exists (#712).
 *
 * ## WHY THESE ARE LEGS AND NOT ONE STATEMENT
 *
 * The page door names one table and has no join. The doors above the grid are
 * rows of three different tables with a count each, and a place is matched on
 * words the vault does not store as a column (the home band is arithmetic on
 * two coordinates). So `PhotosSearchBridge` runs the legs here in order — the
 * entities, their counts, then ONE `media_asset` page whose predicate reaches
 * every entity it matched through `IN (SELECT …)` — and folds them into one
 * `DataArrived`. Everything that is DATA stays in this file, provable with no
 * vault; the bridge is only the trip.
 *
 * `crates/search`'s FTS index is still not reachable: `centraid.core.v1.Request`
 * has no search arm. A caption is matched with `LIKE`, which is v0's own
 * `captionHits` over the words the member themself wrote.
 *
 * ## THE QUERY IS WORDS, NOT A STRING
 *
 * v0's `queryTokens`: lower-cased, split on anything that is not a letter or a
 * digit, one-letter words and a short stop-list dropped — without it "the coast
 * road" pulls every album containing "the". A name matches when it contains ANY
 * of the words. A query that is nothing BUT short words is matched whole, which
 * is where this departs from v0 on purpose: v0 answered a first keystroke with
 * "Nothing matches", and a search that re-reads as the member types must not
 * say that about a word they have not finished.
 */
public object PhotosSearchReads {
    /** How many of each kind stand above the grid (v0's `PER_KIND_CAP`). */
    public const val PER_KIND_CAP: Int = 3

    /** A mosaic's page, the same size the library's is, and for its reason. */
    public const val HIT_LIMIT: Int = 120

    /** An entity leg's ceiling: enough names to choose three from. */
    public const val ENTITY_LIMIT: Int = 50

    /**
     * Every place row, for the vocabulary. The home anchor can be a place with
     * no photograph behind it, so this leg is NOT narrowed to places with
     * photographs — a narrowed read would lose "near home" the day the member
     * has not photographed their own house.
     */
    public const val PLACE_LIMIT: Int = 500

    /**
     * A count leg's page. The door has no `COUNT(*)`, so a count is the rows
     * one page returned and a full page makes it a floor
     * (`SearchTopHit.photo_count_capped`).
     */
    public const val COUNT_LIMIT: Int = 500

    /** How many words of each kind the resting page offers. */
    public const val VOCABULARY_LIMIT: Int = 12

    // -----------------------------------------------------------------------
    // The words.
    // -----------------------------------------------------------------------

    /** v0's stop-list, verbatim. */
    private val STOPWORDS: Set<String> = setOf(
        "a", "an", "and", "at", "for", "from", "in", "of", "on", "the", "to", "with",
    )

    /**
     * The words a query is matched by. See the class note for the one place
     * this departs from v0: a query of short words only is matched whole.
     */
    public fun tokens(query: String): List<String> {
        val lowered = query.trim().lowercase()
        if (lowered.isEmpty()) return emptyList()
        val words = buildList {
            val word = StringBuilder()
            for (character in lowered + " ") {
                if (character.isLetterOrDigit()) {
                    word.append(character)
                } else if (word.isNotEmpty()) {
                    add(word.toString())
                    word.clear()
                }
            }
        }
            .filter { it.length >= 2 && it !in STOPWORDS }
            .distinct()
        return words.ifEmpty { listOf(lowered) }
    }

    /**
     * THE MEMBER'S OWN `%`, `_` AND `\` ARE CHARACTERS, NOT WILDCARDS.
     *
     * A member searching for `50%` gets every caption in the vault if this is
     * left out, and one searching for `a_b` matches `arb`. The escape character
     * is declared on the statement (`ESCAPE '\'`) because SQLite has no default
     * one. The backslash is escaped FIRST, or this would escape the
     * backslashes it had itself just written.
     */
    internal fun escapeLike(query: String): String = query
        .replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")

    /** `(column LIKE ? OR column LIKE ? …)`, one per word, and its binds. */
    private fun anyWord(column: String, words: List<String>): Pair<String, List<Value>> =
        words.joinToString(" OR ", prefix = "(", postfix = ")") {
            "$column LIKE ? ESCAPE '\\'"
        } to words.map { Value(text = "%" + escapeLike(it) + "%") }

    private fun matchesAny(text: String, words: List<String>): Boolean {
        val lowered = text.lowercase()
        return words.any { lowered.contains(it) }
    }

    // -----------------------------------------------------------------------
    // The entity legs.
    // -----------------------------------------------------------------------

    /**
     * THE SHELF THE LIBRARY DRAWS. A search that reached archived or trashed
     * photographs would hand a member back what they put away, from a screen
     * that gives no sign it is doing so.
     */
    private const val LIVE: String = "deleted_at IS NULL AND archived_at IS NULL"

    private const val LIVE_ASSETS: String = "SELECT asset_id FROM media_asset WHERE $LIVE"

    /**
     * A PERSON IS A PARTY SOMEBODY CONFIRMED ON A FACE — never a proposal, which
     * is a model's guess and not a person yet (`PersonRow.photo_count`).
     */
    private const val CONFIRMED_ON_A_LIVE_PHOTO: String =
        "party_id IN (SELECT party_id FROM media_face_region WHERE review_state = ? " +
            "AND asset_id IN ($LIVE_ASSETS))"

    /** `photos.search.people` — people whose name holds a word of the query. */
    public fun peopleQuery(words: List<String>): PageQuery {
        val (names, binds) = anyWord("display_name", words)
        return PageQuery(
            name = "photos.search.people",
            select = listOf("party_id", "display_name"),
            from = PhotosPeopleReads.PARTY_TABLE,
            where_ = "kind = ? AND deleted_at IS NULL AND $names AND $CONFIRMED_ON_A_LIVE_PHOTO",
            bind = listOf(Value(text = PERSON)) + binds + Value(text = CONFIRMED),
            order = PageOrder(sort_column = "display_name", pk_column = "party_id"),
        )
    }

    /**
     * `photos.search.places` — EVERY place row, because the words a place
     * answers to are not all columns: the gazetteer name lives inside
     * `address_json` and the home band is a distance from the Home place.
     * [matchPlaces] decides, the way v0's `placeVocabulary` did.
     */
    public fun placesQuery(): PageQuery = PageQuery(
        name = "photos.search.places",
        select = listOf(
            "place_id",
            "name",
            "kind",
            "geo_lat",
            "geo_lng",
            // THE GAZETTEER'S NAME, read by the vault rather than parsed here:
            // `commonMain` carries no JSON dependency, and `address_json` is
            // `json_valid` by its own CHECK.
            "json_extract(address_json, '$.gazetteer.name') AS gazetteer",
        ),
        from = "core_place",
        order = PageOrder(sort_column = "place_id", pk_column = "place_id"),
    )

    /**
     * `photos.search.albums` — albums whose name holds a word of the query.
     * `kind = 'album'` first: a notebook called "Portugal" is Notes', and is
     * never an album hit here (rung six).
     */
    public fun albumsQuery(words: List<String>): PageQuery {
        val (names, binds) = anyWord("name", words)
        return PageQuery(
            name = "photos.search.albums",
            select = listOf("collection_id", "name"),
            from = "core_collection",
            where_ = "kind = ? AND $names",
            bind = listOf(Value(text = PhotosCollectionsReads.ALBUM_KIND)) + binds,
            order = PageOrder(sort_column = "name", pk_column = "collection_id"),
        )
    }

    /**
     * FLAGS ARE NOT LABELS. The star is the `starred` concept in the flags
     * scheme (#916), and a member searching "star" meant a word, not every
     * favourite they own.
     */
    private const val NOT_A_FLAG: String =
        "scheme_id NOT IN (SELECT scheme_id FROM core_concept_scheme WHERE uri = ?)"

    private const val TAGGED_ON_A_LIVE_PHOTO: String =
        "concept_id IN (SELECT concept_id FROM core_tag WHERE target_type = ? " +
            "AND target_id IN ($LIVE_ASSETS))"

    /**
     * `photos.search.labels` — concepts ACTUALLY on a photograph whose label
     * holds a word of the query. A label is a reason under the grid and never
     * a door above it: there is no shelf of one label's photographs.
     */
    public fun labelsQuery(words: List<String>): PageQuery {
        val (labels, binds) = anyWord("pref_label", words)
        return PageQuery(
            name = "photos.search.labels",
            select = listOf("concept_id", "pref_label"),
            from = "core_concept",
            where_ = "$labels AND $NOT_A_FLAG AND $TAGGED_ON_A_LIVE_PHOTO",
            bind = binds + Value(text = FLAGS_SCHEME_URI) + Value(text = ASSET_TARGET_TYPE),
            order = PageOrder(sort_column = "pref_label", pk_column = "concept_id"),
        )
    }

    // -----------------------------------------------------------------------
    // The count legs, one per kind of door.
    // -----------------------------------------------------------------------

    /** Confirmed faces of these people on live photographs. */
    public fun personCountsQuery(partyIds: List<String>): PageQuery? {
        if (partyIds.isEmpty()) return null
        return PageQuery(
            name = "photos.search.personCounts",
            select = listOf("region_id", "party_id", "asset_id"),
            from = FaceReviewReads.REGION_TABLE,
            where_ = "review_state = ? AND ${inList("party_id", partyIds.size)} " +
                "AND asset_id IN ($LIVE_ASSETS)",
            bind = listOf(Value(text = CONFIRMED)) + partyIds.map { Value(text = it) },
            order = PageOrder(sort_column = "region_id", pk_column = "region_id"),
        )
    }

    /** Live photographs at these places — or, with [unplaced], at none. */
    public fun placeCountsQuery(placeIds: List<String>, unplaced: Boolean): PageQuery? {
        val arms = buildList {
            if (placeIds.isNotEmpty()) add(inList("place_id", placeIds.size))
            if (unplaced) add("place_id IS NULL")
        }
        if (arms.isEmpty()) return null
        return PageQuery(
            name = "photos.search.placeCounts",
            select = listOf("asset_id", "place_id"),
            from = PhotosSearchMachine.TABLE,
            where_ = "$LIVE AND " + arms.joinToString(" OR ", prefix = "(", postfix = ")"),
            bind = placeIds.map { Value(text = it) },
            order = PageOrder(sort_column = "asset_id", pk_column = "asset_id"),
        )
    }

    /**
     * Photographs in these albums. Archived ones count: an album keeps what a
     * member curated whether or not it is on the timeline (`PhotoShelfReads`).
     */
    public fun albumCountsQuery(albumIds: List<String>): PageQuery? {
        if (albumIds.isEmpty()) return null
        return PageQuery(
            name = "photos.search.albumCounts",
            select = listOf("entry_id", "collection_id"),
            from = "core_collection_entry",
            where_ = "target_type = ? AND ${inList("collection_id", albumIds.size)}",
            bind = listOf(Value(text = ASSET_TARGET_TYPE)) + albumIds.map { Value(text = it) },
            order = PageOrder(sort_column = "entry_id", pk_column = "entry_id"),
        )
    }

    // -----------------------------------------------------------------------
    // The photographs.
    // -----------------------------------------------------------------------

    /**
     * WHAT THE QUERY MATCHED, BY ID — the doors above the grid and the labels
     * under it, which together say what the grid may reach.
     */
    public data class Reach(
        val partyIds: List<String> = emptyList(),
        val placeIds: List<String> = emptyList(),
        val unplaced: Boolean = false,
        val albumIds: List<String> = emptyList(),
        val conceptIds: List<String> = emptyList(),
    )

    /**
     * `photos.search.hits` — the grid: every live photograph whose CAPTION
     * holds a word of the query, UNIONED with every one a matched person,
     * place, album or label reaches.
     *
     * One statement, so one keyset walk and one order — the library's,
     * `captured_at DESC, asset_id DESC` — and a photograph two reasons reach is
     * one cell, not two. A NULL `captured_at` rides the first window and no
     * other, for the reason `PhotosReads` states.
     */
    public fun hitsQuery(words: List<String>, reach: Reach): PageQuery {
        val (captions, captionBinds) = anyWord("title", words)
        val arms = mutableListOf("(title IS NOT NULL AND $captions)")
        val binds = captionBinds.toMutableList()
        if (reach.partyIds.isNotEmpty()) {
            arms += "asset_id IN (SELECT asset_id FROM media_face_region WHERE review_state = ? " +
                "AND ${inList("party_id", reach.partyIds.size)})"
            binds += Value(text = CONFIRMED)
            binds += reach.partyIds.map { Value(text = it) }
        }
        if (reach.placeIds.isNotEmpty()) {
            arms += inList("place_id", reach.placeIds.size)
            binds += reach.placeIds.map { Value(text = it) }
        }
        if (reach.unplaced) arms += "place_id IS NULL"
        if (reach.albumIds.isNotEmpty()) {
            arms += "asset_id IN (SELECT target_id FROM core_collection_entry WHERE target_type = ? " +
                "AND ${inList("collection_id", reach.albumIds.size)})"
            binds += Value(text = ASSET_TARGET_TYPE)
            binds += reach.albumIds.map { Value(text = it) }
        }
        if (reach.conceptIds.isNotEmpty()) {
            arms += "asset_id IN (SELECT target_id FROM core_tag WHERE target_type = ? " +
                "AND ${inList("concept_id", reach.conceptIds.size)})"
            binds += Value(text = ASSET_TARGET_TYPE)
            binds += reach.conceptIds.map { Value(text = it) }
        }
        return PageQuery(
            name = "photos.search.hits",
            // `title` IS PROJECTED FOR THE MATCH AND NOT FOR THE CELL: a
            // `PhotoCell` has no title, but "why this matched" for a caption is
            // the caption. Last of the named columns, so the door's three
            // computed ones stay where [THUMBNAIL] says they are.
            select = listOf(
                "asset_id",
                "captured_at",
                "tz_offset_min",
                "kind",
                "capture_group_id",
                "title",
            ),
            from = PhotosSearchMachine.TABLE,
            where_ = "$LIVE AND " + arms.joinToString(" OR ", prefix = "(", postfix = ")"),
            bind = binds,
            order = PageOrder(
                sort_column = "captured_at",
                pk_column = "asset_id",
                descending = true,
            ),
            with_held_thumbnail = true,
        )
    }

    // -----------------------------------------------------------------------
    // The folds.
    // -----------------------------------------------------------------------

    /** One named thing a query matched: its id and the vault's word for it. */
    public data class Named(val id: String, val label: String)

    /** The people leg, as names, alphabetical, three at most. */
    public fun people(rows: List<Row>): List<Named> = rows
        .mapNotNull { row ->
            val id = row.text(0)
            val name = row.text(1).trim()
            if (id.isEmpty() || name.isEmpty()) null else Named(id, name)
        }
        .sortedWith(compareBy({ it.label.lowercase() }, { it.id }))
        .take(PER_KIND_CAP)

    /** The albums leg, the same way. */
    public fun albums(rows: List<Row>): List<Named> = people(rows)

    /** The labels leg. Not capped: a label is a reason, and reasons are the view's to clamp. */
    public fun labels(rows: List<Row>): List<Named> = rows.mapNotNull { row ->
        val id = row.text(0)
        val label = row.text(1).trim()
        if (id.isEmpty() || label.isEmpty()) null else Named(id, label)
    }

    /** The places a query matched, and whether it asked for "no location". */
    public data class PlaceMatch(val places: List<Named>, val unplaced: Boolean)

    /**
     * WHAT A PLACE ANSWERS TO (v0's `search-place-vocabulary.ts`): the member's
     * own name for it, the gazetteer's settlement, and — for a place within a
     * town's span of Home — "home", "at home", "near home" and its band.
     * **Never a coordinate**, and no home words at all when no Home is
     * declared: a guess at where the member lives is not vocabulary.
     *
     * "Away" is deliberately not a word: 250 km from home is not near home.
     *
     * The printed label is the member's name, else the gazetteer's; a place
     * with neither has nothing a member could read and is not a door.
     *
     * The no-location bucket is matched as a PHRASE ("no location", "no
     * place", "unlocated"): "place" as a bare word would hit every place row.
     */
    public fun matchPlaces(rows: List<Row>, query: String): PlaceMatch {
        val words = tokens(query)
        val places = rows.map(::placeOf)
        val home = places.firstOrNull { it.isHome && it.latitude != null && it.longitude != null }
        val matched = places
            .filter { place -> vocabulary(place, home).any { matchesAny(it, words) } }
            .mapNotNull { place -> place.label?.let { Named(place.id, it) } }
            .sortedWith(compareBy({ it.label.lowercase() }, { it.id }))
        return PlaceMatch(places = matched, unplaced = noLocationAsked(query))
    }

    private data class PlaceWords(
        val id: String,
        val name: String?,
        val gazetteer: String?,
        val isHome: Boolean,
        val latitude: Double?,
        val longitude: Double?,
    ) {
        val label: String? get() = name ?: gazetteer
    }

    private fun placeOf(row: Row): PlaceWords = PlaceWords(
        id = row.text(0),
        name = PlacesReads.readableName(row.text(1)),
        gazetteer = row.text(5).trim().ifEmpty { null },
        isHome = row.text(2) == "home",
        latitude = row.values.getOrNull(3)?.real,
        longitude = row.values.getOrNull(4)?.real,
    )

    private fun vocabulary(place: PlaceWords, home: PlaceWords?): List<String> = buildList {
        place.name?.let(::add)
        place.gazetteer?.let(::add)
        val lat = place.latitude
        val lng = place.longitude
        val homeLat = home?.latitude
        val homeLng = home?.longitude
        if (lat != null && lng != null && homeLat != null && homeLng != null) {
            val km = distanceKm(lat, lng, homeLat, homeLng)
            val band = when {
                km <= AT_HOME_KM -> "at home"
                km <= AROUND_TOWN_KM -> "around town"
                else -> null
            }
            if (band != null) {
                addAll(HOME_TERMS)
                add(band)
            }
        }
    }

    /** v0's `PLACE_HOME_TERMS`. */
    private val HOME_TERMS: List<String> = listOf("home", "at home", "near home")

    /** v0's `PLACE_NO_LOCATION_TERMS`. */
    private val NO_LOCATION_TERMS: List<String> = listOf("no location", "no place", "unlocated")

    /** v0's `place-phrase.ts` bands, in kilometres. */
    private const val AT_HOME_KM: Double = 0.5
    private const val AROUND_TOWN_KM: Double = 25.0

    /** Matched as a phrase, either way round, as v0's `noLocationAsked` was. */
    internal fun noLocationAsked(query: String): Boolean {
        val asked = query.trim().lowercase()
        if (asked.isEmpty()) return false
        return NO_LOCATION_TERMS.any { term -> term.contains(asked) || asked.contains(term) }
    }

    /** Great-circle distance, v0's `distanceKm`. */
    private fun distanceKm(aLat: Double, aLng: Double, bLat: Double, bLng: Double): Double {
        val dLat = radians(bLat - aLat)
        val dLng = radians(bLng - aLng)
        val h = sin(dLat / 2) * sin(dLat / 2) +
            cos(radians(aLat)) * cos(radians(bLat)) * sin(dLng / 2) * sin(dLng / 2)
        return 2 * EARTH_RADIUS_KM * asin(min(1.0, sqrt(h)))
    }

    private fun radians(degrees: Double): Double = degrees * kotlin.math.PI / 180.0

    private const val EARTH_RADIUS_KM: Double = 6371.0088

    /** v0's `PLACE_NO_LOCATION`, the name of the bucket's door. */
    public const val NO_LOCATION_NAME: String = PlacesMachine.NO_LOCATION_NAME

    /** A count off one page: how many distinct photographs each key reached. */
    public data class Counted(val byKey: Map<String, Int>, val capped: Boolean)

    /**
     * DISTINCT PHOTOGRAPHS PER KEY, from one count page. Two faces of one
     * person in one photograph are one photograph. [keyAt] and [assetAt] are
     * the row positions the leg projected.
     */
    public fun counted(rows: List<Row>, keyAt: Int, assetAt: Int, limit: Int): Counted {
        val seen = LinkedHashMap<String, MutableSet<String>>()
        for (row in rows) {
            val key = row.text(keyAt)
            seen.getOrPut(key) { mutableSetOf() } += row.text(assetAt)
        }
        return Counted(byKey = seen.mapValues { it.value.size }, capped = rows.size >= limit)
    }

    /**
     * THE DOORS ABOVE THE GRID, in v0's order — person, place, album,
     * narrowest to broadest — three of each at most. The no-location bucket is
     * a place and comes LAST among them: a typed name wants the name first.
     *
     * A person or a place with no photograph behind it is not a door (v0 drops
     * a zero), but an album is: an empty album is still a thing the member
     * named and may want to open and fill.
     */
    public fun topHits(
        people: List<Named>,
        personCounts: Counted,
        places: PlaceMatch,
        placeCounts: Counted,
        albums: List<Named>,
        albumCounts: Counted,
    ): List<SearchTopHit> {
        val personDoors = people.mapNotNull { person ->
            val count = personCounts.byKey[person.id] ?: 0
            if (count == 0) {
                null
            } else {
                SearchTopHit(
                    kind = SearchMatch.Kind.KIND_PERSON,
                    label = person.label,
                    photo_count = count,
                    photo_count_capped = personCounts.capped,
                    shelf = PhotoShelf(
                        state_view = PhotoStateView(
                            person = PhotoStateView.Person(
                                party_id = person.id,
                                person_name = person.label,
                            ),
                        ),
                    ),
                )
            }
        }
        val named = places.places.mapNotNull { place ->
            val count = placeCounts.byKey[place.id] ?: 0
            if (count == 0) {
                null
            } else {
                SearchTopHit(
                    kind = SearchMatch.Kind.KIND_PLACE,
                    label = place.label,
                    photo_count = count,
                    photo_count_capped = placeCounts.capped,
                    shelf = PhotoShelf(
                        place = PhotoShelf.Place(place_id = place.id, place_name = place.label),
                    ),
                )
            }
        }
        // THE COUNT LEG KEYS AN UNPLACED ROW BY THE EMPTY STRING, which is what
        // a NULL `place_id` reads as on the door.
        val unplacedCount = placeCounts.byKey[""] ?: 0
        val bucket = if (places.unplaced && unplacedCount > 0) {
            listOf(
                SearchTopHit(
                    kind = SearchMatch.Kind.KIND_PLACE,
                    label = NO_LOCATION_NAME,
                    photo_count = unplacedCount,
                    photo_count_capped = placeCounts.capped,
                    shelf = unplacedShelf(),
                ),
            )
        } else {
            emptyList()
        }
        val albumDoors = albums.map { album ->
            SearchTopHit(
                kind = SearchMatch.Kind.KIND_ALBUM,
                label = album.label,
                photo_count = albumCounts.byKey[album.id] ?: 0,
                photo_count_capped = albumCounts.capped,
                shelf = PhotoShelf(
                    album = PhotoShelf.Album(collection_id = album.id, name = album.label),
                ),
            )
        }
        return personDoors.take(PER_KIND_CAP) +
            (named + bucket).take(PER_KIND_CAP) +
            albumDoors.take(PER_KIND_CAP)
    }

    /**
     * THE PHOTOGRAPHS WITH NO PLACE, as a shelf — Places' own value, so the two
     * doors land on one shelf.
     */
    public fun unplacedShelf(): PhotoShelf = PlacesMachine.unplacedShelf()

    /**
     * What the grid may reach, from the doors that were kept and the labels.
     * Only the KEPT doors: a fourth person the member cannot see above the
     * grid must not be why photographs are in it (v0's `reachableAssetIds`).
     */
    public fun reach(topHits: List<SearchTopHit>, labels: List<Named>): Reach = Reach(
        partyIds = topHits.mapNotNull { it.shelf?.state_view?.person?.party_id },
        placeIds = topHits.mapNotNull { hit ->
            hit.shelf?.place?.takeIf { !it.unplaced }?.place_id
        },
        unplaced = topHits.any { it.shelf?.place?.unplaced == true },
        albumIds = topHits.mapNotNull { it.shelf?.album?.collection_id },
        conceptIds = labels.map { it.id },
    )

    /**
     * The hits.
     *
     * **AN EMPTY PAGE IS A REAL ANSWER AND REACHES THE SCREEN AS DATA** — the
     * "nothing matches" state, a different screen from resting and from a
     * refusal. No cells AND no doors is nothing; doors over an empty grid is
     * still an answer (an empty album the member named).
     *
     * `matches` says WHY, deduped: the doors' names, the labels, and the
     * captions the page landed on, in the page's own order. How many of them
     * FIT is the view's decision, not this one.
     *
     * [query] is the query the legs were run for, carried so a reducer whose
     * field has moved on can tell a late page from a current one.
     */
    public fun hitsArrived(
        query: String,
        rows: List<Row>,
        nextCursor: String?,
        topHits: List<SearchTopHit>,
        labels: List<Named>,
    ): PhotosSearchEvent {
        val words = tokens(query)
        val doors = topHits.map { SearchMatch(kind = it.kind, value_ = it.label) }
        val labelled = labels.map { SearchMatch(kind = SearchMatch.Kind.KIND_LABEL, value_ = it.label) }
        val captions = rows
            .map { it.text(TITLE).trim() }
            .filter { it.isNotEmpty() && matchesAny(it, words) }
            .map { SearchMatch(kind = SearchMatch.Kind.KIND_TITLE, value_ = it) }
        return PhotosSearchEvent(
            data_ = PhotosSearchEvent.DataArrived(
                hits = SearchHits(
                    cells = rows.map(::cellOf),
                    next_cursor = nextCursor,
                    matches = (doors + labelled + captions).distinct(),
                    top_hits = topHits,
                    query = query,
                ),
            ),
        )
    }

    public fun refused(failure: ReadFailure): PhotosSearchEvent =
        PhotosSearchEvent(refused = PhotosSearchEvent.ReadRefused(failure = failure))

    // -----------------------------------------------------------------------
    // The resting page: what there is to search FOR.
    // -----------------------------------------------------------------------

    /** `photos.search.resting.people` — everyone confirmed on a live photograph. */
    public fun restingPeopleQuery(): PageQuery = PageQuery(
        name = "photos.search.resting.people",
        select = listOf("party_id", "display_name"),
        from = PhotosPeopleReads.PARTY_TABLE,
        where_ = "kind = ? AND deleted_at IS NULL AND $CONFIRMED_ON_A_LIVE_PHOTO",
        bind = listOf(Value(text = PERSON), Value(text = CONFIRMED)),
        order = PageOrder(sort_column = "display_name", pk_column = "party_id"),
    )

    /** `photos.search.resting.places` — places with a live photograph behind them. */
    public fun restingPlacesQuery(): PageQuery = PageQuery(
        name = "photos.search.resting.places",
        select = listOf(
            "place_id",
            "name",
            "json_extract(address_json, '$.gazetteer.name') AS gazetteer",
        ),
        from = "core_place",
        where_ = "place_id IN (SELECT place_id FROM media_asset WHERE $LIVE AND place_id IS NOT NULL)",
        order = PageOrder(sort_column = "name", pk_column = "place_id"),
    )

    /**
     * `photos.search.resting.labels` — concepts the vault has actually put on
     * a live photograph, never a list of words the product hopes are there.
     */
    public fun restingLabelsQuery(): PageQuery = PageQuery(
        name = "photos.search.resting.labels",
        select = listOf("concept_id", "pref_label"),
        from = "core_concept",
        where_ = "$NOT_A_FLAG AND $TAGGED_ON_A_LIVE_PHOTO",
        bind = listOf(Value(text = FLAGS_SCHEME_URI), Value(text = ASSET_TARGET_TYPE)),
        order = PageOrder(sort_column = "pref_label", pk_column = "concept_id"),
    )

    /**
     * The vocabulary. A leg that could not be read is an EMPTY list here and
     * not a refused screen: the resting page is decoration over an empty
     * field, and a sentence about a failed read where a member has not asked
     * anything would be an error nobody caused.
     */
    public fun restingArrived(
        peopleRows: List<Row>,
        placeRows: List<Row>,
        labelRows: List<Row>,
    ): PhotosSearchEvent = PhotosSearchEvent(
        resting = PhotosSearchEvent.RestingArrived(
            resting = SearchResting(
                people = peopleRows.mapNotNull { row ->
                    val id = row.text(0)
                    val name = row.text(1).trim()
                    if (id.isEmpty() || name.isEmpty()) {
                        null
                    } else {
                        PhotoPerson(party_id = id, display_name = name)
                    }
                },
                places = placeRows.mapNotNull { row ->
                    val id = row.text(0)
                    val label = PlacesReads.readableName(row.text(1))
                        ?: row.text(2).trim().ifEmpty { null }
                    if (id.isEmpty() || label == null) {
                        null
                    } else {
                        PhotoShelf.Place(place_id = id, place_name = label)
                    }
                },
                suggested_labels = labelRows.mapNotNull { row ->
                    val id = row.text(0)
                    val label = row.text(1).trim()
                    if (id.isEmpty() || label.isEmpty()) {
                        null
                    } else {
                        PhotoLabel(concept_id = id, label = label)
                    }
                },
            ),
        ),
    )

    // -----------------------------------------------------------------------
    // One cell.
    // -----------------------------------------------------------------------

    /**
     * One cell out of one row, with the SAME projection the library grid makes.
     *
     * **`PhotosReads.heldOf` IS CALLED AND NOT COPIED.** It is the one function
     * allowed to produce `PhotoCell.Held`, and a second spelling of "which cell
     * gets the download arrow" is a second answer waiting to disagree.
     */
    private fun cellOf(row: Row): PhotoCell {
        val kind = kindOf(row.text(3))
        val thumbnail = row.text(THUMBNAIL)
        val originalHash = row.text(ORIGINAL_HASH)
        return PhotoCell(
            asset_id = row.text(0),
            captured_at = row.text(1),
            captured_utc_offset_minutes = row.integer(2).toInt(),
            kind = kind,
            capture_group_id = row.text(4).ifEmpty { null },
            thumbnail_path = thumbnail.ifEmpty { null },
            original_hash = originalHash,
            held = PhotosReads.heldOf(
                thumbnail = thumbnail.isNotEmpty(),
                originalHeld = row.integer(ORIGINAL_HELD) > 0L,
                originalHash = originalHash,
                kind = kind,
                rule = LinkConditions.rule,
                metered = LinkConditions.metered,
            ),
        )
    }

    private fun kindOf(kind: String): PhotoCell.Kind = when (kind) {
        "photo" -> PhotoCell.Kind.KIND_PHOTO
        "video" -> PhotoCell.Kind.KIND_VIDEO
        "audio" -> PhotoCell.Kind.KIND_AUDIO
        "scan" -> PhotoCell.Kind.KIND_SCAN
        // An unrecognised value is UNSPECIFIED and not a photograph.
        else -> PhotoCell.Kind.KIND_UNSPECIFIED
    }

    private fun inList(column: String, count: Int): String =
        column + " IN (" + List(count) { "?" }.joinToString(", ") + ")"

    /** The caption, last of the SIX named columns of [hitsQuery]. */
    private const val TITLE: Int = 5

    /**
     * After the six named columns; see [hitsQuery]'s `with_held_thumbnail`.
     * They move together with its `select` list and nowhere else.
     */
    private const val THUMBNAIL: Int = 6
    private const val ORIGINAL_HASH: Int = 7
    private const val ORIGINAL_HELD: Int = 8

    private const val PERSON: String = "person"
    private const val CONFIRMED: String = "confirmed"

    /** `crates/apps/photos`' `TAG_TARGET_TYPE`, spelled the same. */
    private const val ASSET_TARGET_TYPE: String = "media.asset"

    /** The flags scheme, as `PhotoShelfReads` names it. */
    private const val FLAGS_SCHEME_URI: String = "https://centraid.dev/schemes/flags"

    /** Positional, as the door states. See `HomeReads.text` for why only TEXT. */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""

    private fun Row.integer(index: Int): Long = values.getOrNull(index)?.integer ?: 0L
}
