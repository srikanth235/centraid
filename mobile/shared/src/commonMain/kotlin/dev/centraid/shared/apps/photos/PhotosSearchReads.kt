package dev.centraid.shared.apps.photos

import centraid.core.v1.ContainerHit
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotoLabel
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PhotosSearchEvent
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SearchHits
import centraid.screen.v1.SearchMatch
import centraid.screen.v1.SearchResting
import centraid.screen.v1.SearchTopHit
import dev.centraid.shared.sync.LinkConditions

/**
 * WHAT SEARCH READS, AND WHAT IT MAKES OF THE ROWS (#1029, the photos port).
 *
 * v0's `search-hits.ts` is the spec: a query reaches **places** (the member's
 * name and the gazetteer's), **albums**, **labels** (tags
 * on a photograph) and **text** (the caption, and now the words
 * recognised in the picture and a video's transcript), and the answer is two
 * things — the places and albums it NAMED, as doors above the grid, and the
 * photographs all of them REACH, as the grid. Typing "Tahoe" returns the
 * album's photographs, not an empty grid under a row saying the album exists
 * (#712). v0 also reached **people** (confirmed parties); that leg left with
 * the face surfaces (Q-1047-2).
 *
 * ## WHAT THE CORE ANSWERS AND WHAT STAYS HERE (#1097, R-1097-25, R-1097-26)
 *
 * The TEXT leg and the ALBUM leg are the full-text door's: the core answers
 * `photos.search` (`photos.proto`) with the live photographs whose caption, text
 * or transcript hold the words, in rank order, and the albums whose name does,
 * and it corrects a typo when asked ([PhotosSearchBridge] asks only when every
 * leg here found nothing). This object holds the STRUCTURED legs — the places,
 * the labels — and the folds, none of which has a full-text index to ask.
 *
 * ## WHY THESE ARE LEGS AND NOT ONE STATEMENT
 *
 * The page door names one table and has no join. The doors above the grid are
 * rows of two different tables with a count each, and a place is matched on
 * words the vault does not store as a column (the home band is arithmetic on
 * two coordinates). So `PhotosSearchBridge` runs the legs here in order — the
 * entities, their counts, then ONE `photo` page whose predicate reaches
 * every entity it matched through `IN (SELECT …)`, and the photographs the core
 * named by id — and folds them into one `DataArrived`. Everything that is DATA
 * stays in this file, provable with no vault; the bridge is only the trip.
 *
 * ## THE QUERY IS WORDS, NOT A STRING
 *
 * v0's `queryTokens`: lower-cased, split on anything that is not a letter or a
 * digit, one-letter words and a short stop-list dropped — without it "the coast
 * road" pulls every place containing "the". A name matches when it contains ANY
 * of the words. A query that is nothing BUT short words is matched whole, which
 * is where this departs from v0 on purpose: v0 answered a first keystroke with
 * "Nothing matches", and a search that re-reads as the member types must not
 * say that about a word they have not finished.
 */
public object PhotosSearchReads {
    /** How many of each kind stand above the grid (v0's `PER_KIND_CAP`). */
    public const val PER_KIND_CAP: Int = 3

    /** The photographs the core names by text: the best of them by rank (`photos.proto`). */
    public const val TEXT_LIMIT: Int = 500

    /** A mosaic's page, the same size the library's is, and for its reason. */
    public const val HIT_LIMIT: Int = 120

    /** An entity leg's ceiling: enough names to choose three from. */
    public const val ENTITY_LIMIT: Int = 50

    /**
     * Every place, for the vocabulary: a place with no photograph behind it is
     * still a name a member typed once, and the shelf it opens is empty, not
     * missing.
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
    private const val LIVE: String = PhotoFold.LIVE

    private const val LIVE_ASSETS: String = "SELECT id FROM photo WHERE $LIVE"

    /**
     * `photos.search.places` — the places' NAMES, from their `entity`: the member's
     * own word is the title, and the trash is the entity's. The gazetteer's
     * nearest city is the `place` row's ([placeGeoQuery]); the words a place
     * answers to are decided by [matchPlaces], the way v0's `placeVocabulary` did.
     */
    public fun placesQuery(): PageQuery = PageQuery(
        name = "photos.search.places",
        select = listOf("id", "title"),
        from = "entity",
        where_ = "kind = 'place' AND deleted_at IS NULL",
        order = PageOrder(sort_column = "id", pk_column = "id"),
    )

    /**
     * `photos.search.placeGeo` — each place's gazetteer name (`locality`, written by
     * `place.locate`) beside the name. The model keeps no home place (R-1135-5-3),
     * so no home words are vocabulary.
     */
    public fun placeGeoQuery(): PageQuery = PageQuery(
        name = "photos.search.placeGeo",
        select = listOf("id", "locality"),
        from = "place",
        order = PageOrder(sort_column = "id", pk_column = "id"),
    )

    /**
     * `photos.search.labels` — tags ACTUALLY on a live photograph whose title
     * holds a word of the query. A label is a reason under the grid and never
     * a door above it: there is no shelf of one label's photographs.
     *
     * FLAGS ARE NOT LABELS: the star and the archive are entities of kind `flag`
     * and a tag is one of kind `tag`, so `kind = 'tag'` is the whole of the rule
     * (#916), and a member searching "star" meant a word, not every favourite they
     * own.
     */
    public fun labelsQuery(words: List<String>): PageQuery {
        val (labels, binds) = anyWord("title", words)
        return PageQuery(
            name = "photos.search.labels",
            select = listOf("id", "title"),
            from = "entity",
            where_ = "kind = 'tag' AND deleted_at IS NULL AND $labels AND $TAGGED_ON_A_LIVE_PHOTO",
            bind = binds,
            order = PageOrder(sort_column = "title", pk_column = "id"),
        )
    }

    private const val TAGGED_ON_A_LIVE_PHOTO: String =
        "id IN (SELECT to_id FROM edge WHERE rel = 'tagged' AND from_id IN ($LIVE_ASSETS))"

    // -----------------------------------------------------------------------
    // The count legs, one per kind of door.
    // -----------------------------------------------------------------------

    /** Live photographs at these places — or, with [unplaced], at none. */
    public fun placeCountsQuery(placeIds: List<String>, unplaced: Boolean): PageQuery? {
        val arms = buildList {
            if (placeIds.isNotEmpty()) add(inList("place_id", placeIds.size))
            if (unplaced) add("place_id IS NULL")
        }
        if (arms.isEmpty()) return null
        return PageQuery(
            name = "photos.search.placeCounts",
            select = listOf("id", "place_id"),
            from = PhotosSearchMachine.TABLE,
            where_ = "$LIVE AND " + arms.joinToString(" OR ", prefix = "(", postfix = ")"),
            bind = placeIds.map { Value(text = it) },
            order = PageOrder(sort_column = "id", pk_column = "id"),
        )
    }

    /**
     * Photographs in these albums: the `contains` edges, album first. Archived ones
     * count: an album keeps what a member curated whether or not it is on the
     * timeline (`PhotoShelfReads`); trashed ones do not, for they keep their
     * membership only so a restore can bring it back.
     */
    public fun albumCountsQuery(albumIds: List<String>): PageQuery? {
        if (albumIds.isEmpty()) return null
        return PageQuery(
            name = "photos.search.albumCounts",
            select = listOf("from_id", "to_id"),
            from = "edge",
            where_ = "rel = 'contains' AND ${inList("from_id", albumIds.size)} AND " +
                "to_id IN (SELECT id FROM entity WHERE kind = 'photo' AND deleted_at IS NULL)",
            bind = albumIds.map { Value(text = it) },
            order = PageOrder(sort_column = "from_id", pk_column = "to_id"),
        )
    }

    // -----------------------------------------------------------------------
    // The photographs.
    // -----------------------------------------------------------------------

    /**
     * WHAT THE QUERY MATCHED, BY ID — the doors above the grid, the labels under
     * it and the photographs the core named by text, which together say what the
     * grid may reach.
     */
    public data class Reach(
        val placeIds: List<String> = emptyList(),
        val unplaced: Boolean = false,
        val albumIds: List<String> = emptyList(),
        val conceptIds: List<String> = emptyList(),
        /** The photographs whose caption, text or transcript the core's door found. */
        val assetIds: List<String> = emptyList(),
    ) {
        /** Nothing reached: the grid has nothing to read, and no statement is made. */
        val isEmpty: Boolean
            get() = placeIds.isEmpty() && !unplaced &&
                albumIds.isEmpty() && conceptIds.isEmpty() && assetIds.isEmpty()
    }

    /**
     * `photos.search.hits` — the grid: every live photograph the core's door
     * named by its text (caption, recognised text, transcript), UNIONED with
     * every one a matched place, album or label reaches. **Null when
     * nothing was reached**: a statement with no arm would read the whole shelf.
     *
     * One statement, so one keyset walk and one order — the library's,
     * `captured_at DESC, asset_id DESC` — and a photograph two reasons reach is
     * one cell, not two. The text leg's RANK decides which photographs are in
     * (the core names the best of them) and not where they sit: a mosaic that
     * reordered itself by relevance would not be the shelf the library draws. A
     * NULL `captured_at` rides the first window and no other, for the reason
     * `PhotosReads` states.
     */
    public fun hitsQuery(reach: Reach): PageQuery? {
        if (reach.isEmpty) return null
        val arms = mutableListOf<String>()
        val binds = mutableListOf<Value>()
        if (reach.assetIds.isNotEmpty()) {
            arms += inList("id", reach.assetIds.size)
            binds += reach.assetIds.map { Value(text = it) }
        }
        if (reach.placeIds.isNotEmpty()) {
            arms += inList("place_id", reach.placeIds.size)
            binds += reach.placeIds.map { Value(text = it) }
        }
        if (reach.unplaced) arms += "place_id IS NULL"
        if (reach.albumIds.isNotEmpty()) {
            arms += "id IN (SELECT to_id FROM edge WHERE rel = 'contains' " +
                "AND ${inList("from_id", reach.albumIds.size)})"
            binds += reach.albumIds.map { Value(text = it) }
        }
        if (reach.conceptIds.isNotEmpty()) {
            arms += "id IN (SELECT from_id FROM edge WHERE rel = 'tagged' " +
                "AND ${inList("to_id", reach.conceptIds.size)})"
            binds += reach.conceptIds.map { Value(text = it) }
        }
        return PageQuery(
            name = "photos.search.hits",
            // THE CELL'S FIVE, in `PhotosReads`' order. A caption is the entity's
            // title, so "why this matched" for a caption is a second read
            // ([titlesQuery]) the bridge makes over the page that landed.
            select = listOf(
                "id",
                "taken_at",
                "offset_min",
                "form",
                "burst",
            ),
            from = PhotosSearchMachine.TABLE,
            where_ = "$LIVE AND " + arms.joinToString(" OR ", prefix = "(", postfix = ")"),
            bind = binds,
            order = PageOrder(
                sort_column = "taken_at",
                pk_column = "id",
                descending = true,
            ),
            with_held_thumbnail = true,
        )
    }

    /**
     * `photos.search.titles` — the captions of the photographs a hits page landed
     * on, from their `entity`, so a caption that matched can be said as the reason.
     * Null when there are none.
     */
    public fun titlesQuery(assetIds: List<String>): PageQuery? {
        val ids = assetIds.filter { it.isNotEmpty() }.distinct()
        if (ids.isEmpty()) return null
        return PageQuery(
            name = "photos.search.titles",
            select = listOf("id", "title"),
            from = "entity",
            where_ = inList("id", ids.size),
            bind = ids.map { Value(text = it) },
            order = PageOrder(sort_column = "id", pk_column = "id"),
        )
    }

    // -----------------------------------------------------------------------
    // The folds.
    // -----------------------------------------------------------------------

    /** One named thing a query matched: its id and the vault's word for it. */
    public data class Named(val id: String, val label: String)

    /**
     * The albums leg: the core's container hits (`photos.search`, narrowed to
     * the rows that open in Photos), IN THE DOOR'S RANK ORDER and three at most.
     * An album with no title is no door.
     */
    public fun albums(hits: List<ContainerHit>): List<Named> = hits
        .mapNotNull { hit ->
            val name = hit.title.trim()
            if (hit.id.isEmpty() || name.isEmpty()) null else Named(hit.id, name)
        }
        .take(PER_KIND_CAP)

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
     * own name for it and the gazetteer's settlement. **Never a coordinate.** The
     * model keeps no home place (R-1135-5-3), so "home", "at home" and "near home"
     * are no words: a guess at where the member lives is not vocabulary.
     *
     * The printed label is the member's name, else the gazetteer's; a place
     * with neither has nothing a member could read and is not a door.
     *
     * The no-location bucket is matched as a PHRASE ("no location", "no
     * place", "unlocated"): "place" as a bare word would hit every place row.
     *
     * [names] are the places' `entity` rows (`id, title`) and [geo] their `place`
     * rows (`id, locality`), joined by id.
     */
    public fun matchPlaces(names: List<Row>, geo: List<Row>, query: String): PlaceMatch {
        val words = tokens(query)
        val gazetteer = geo.associate { it.text(0) to it.text(1).trim().ifEmpty { null } }
        val places = names.map { row ->
            PlaceWords(
                id = row.text(0),
                name = PlacesReads.readableName(row.text(1)),
                gazetteer = gazetteer[row.text(0)],
            )
        }
        val matched = places
            .filter { place -> vocabulary(place).any { matchesAny(it, words) } }
            .mapNotNull { place -> place.label?.let { Named(place.id, it) } }
            .sortedWith(compareBy({ it.label.lowercase() }, { it.id }))
        return PlaceMatch(places = matched, unplaced = noLocationAsked(query))
    }

    private data class PlaceWords(
        val id: String,
        val name: String?,
        val gazetteer: String?,
    ) {
        val label: String? get() = name ?: gazetteer
    }

    private fun vocabulary(place: PlaceWords): List<String> = buildList {
        place.name?.let(::add)
        place.gazetteer?.let(::add)
    }

    /** v0's `PLACE_NO_LOCATION_TERMS`. */
    private val NO_LOCATION_TERMS: List<String> = listOf("no location", "no place", "unlocated")

    /** Matched as a phrase, either way round, as v0's `noLocationAsked` was. */
    internal fun noLocationAsked(query: String): Boolean {
        val asked = query.trim().lowercase()
        if (asked.isEmpty()) return false
        return NO_LOCATION_TERMS.any { term -> term.contains(asked) || asked.contains(term) }
    }

    /** v0's `PLACE_NO_LOCATION`, the name of the bucket's door. */
    public const val NO_LOCATION_NAME: String = PlacesMachine.NO_LOCATION_NAME

    /** A count off one page: how many distinct photographs each key reached. */
    public data class Counted(val byKey: Map<String, Int>, val capped: Boolean)

    /**
     * DISTINCT PHOTOGRAPHS PER KEY, from one count page. Two rows of one key
     * on one photograph are one photograph. [keyAt] and [assetAt] are the row
     * positions the leg projected.
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
     * THE DOORS ABOVE THE GRID, in v0's order — place, album, narrowest to
     * broadest — three of each at most. The no-location bucket is a place and
     * comes LAST among them: a typed name wants the name first.
     *
     * A place with no photograph behind it is not a door (v0 drops a zero), but
     * an album is: an empty album is still a thing the member
     * named and may want to open and fill.
     */
    public fun topHits(
        places: PlaceMatch,
        placeCounts: Counted,
        albums: List<Named>,
        albumCounts: Counted,
    ): List<SearchTopHit> {
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
        return (named + bucket).take(PER_KIND_CAP) +
            albumDoors.take(PER_KIND_CAP)
    }

    /**
     * THE PHOTOGRAPHS WITH NO PLACE, as a shelf — Places' own value, so the two
     * doors land on one shelf.
     */
    public fun unplacedShelf(): PhotoShelf = PlacesMachine.unplacedShelf()

    /**
     * What the grid may reach, from the doors that were kept and the labels.
     * Only the KEPT doors: a fourth place the member cannot see above the
     * grid must not be why photographs are in it (v0's `reachableAssetIds`).
     */
    public fun reach(
        topHits: List<SearchTopHit>,
        labels: List<Named>,
        assetIds: List<String> = emptyList(),
    ): Reach = Reach(
        assetIds = assetIds,
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
     * captions the page landed on, in the page's own order. A photograph the
     * core found by the text recognised in it or by its transcript carries no
     * reason here: the caption is the one text the row holds. How many of them
     * FIT is the view's decision, not this one.
     *
     * [titles] are the captions of the photographs on the page (`id` to title), the
     * entity's and a read of their own ([titlesQuery]).
     *
     * [query] is the query the legs were run for, carried so a reducer whose
     * field has moved on can tell a late page from a current one. [corrected]
     * is the words the answer searched when the typed ones were corrected
     * (#1097, R-1097-27), else empty; the captions are matched against THOSE
     * words, because they are what the page was read for.
     */
    public fun hitsArrived(
        query: String,
        rows: List<Row>,
        nextCursor: String?,
        topHits: List<SearchTopHit>,
        labels: List<Named>,
        corrected: String = "",
        titles: Map<String, String> = emptyMap(),
    ): PhotosSearchEvent {
        val words = tokens(corrected.ifEmpty { query })
        val doors = topHits.map { SearchMatch(kind = it.kind, value_ = it.label) }
        val labelled = labels.map { SearchMatch(kind = SearchMatch.Kind.KIND_LABEL, value_ = it.label) }
        val captions = rows
            .map { titles[it.text(0)].orEmpty().trim() }
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
                corrected = corrected,
            ),
        )
    }

    public fun refused(failure: ReadFailure): PhotosSearchEvent =
        PhotosSearchEvent(refused = PhotosSearchEvent.ReadRefused(failure = failure))

    // -----------------------------------------------------------------------
    // The resting page: what there is to search FOR.
    // -----------------------------------------------------------------------

    /** `photos.search.resting.places` — places with a live photograph behind them, by name. */
    public fun restingPlacesQuery(): PageQuery = PageQuery(
        name = "photos.search.resting.places",
        select = listOf("id", "title"),
        from = "entity",
        where_ = "kind = 'place' AND deleted_at IS NULL AND id IN (SELECT place_id FROM photo WHERE $LIVE AND place_id IS NOT NULL)",
        order = PageOrder(sort_column = "title", pk_column = "id"),
    )

    /**
     * `photos.search.resting.labels` — tags the vault has actually put on a live
     * photograph, never a list of words the product hopes are there.
     */
    public fun restingLabelsQuery(): PageQuery = PageQuery(
        name = "photos.search.resting.labels",
        select = listOf("id", "title"),
        from = "entity",
        where_ = "kind = 'tag' AND deleted_at IS NULL AND $TAGGED_ON_A_LIVE_PHOTO",
        order = PageOrder(sort_column = "title", pk_column = "id"),
    )

    /**
     * The vocabulary. A leg that could not be read is an EMPTY list here and
     * not a refused screen: the resting page is decoration over an empty
     * field, and a sentence about a failed read where a member has not asked
     * anything would be an error nobody caused.
     */
    public fun restingArrived(
        placeRows: List<Row>,
        labelRows: List<Row>,
    ): PhotosSearchEvent = PhotosSearchEvent(
        resting = PhotosSearchEvent.RestingArrived(
            resting = SearchResting(
                places = placeRows.mapNotNull { row ->
                    val id = row.text(0)
                    val label = PlacesReads.readableName(row.text(1))
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
        val kind = PhotosReads.kindOf(row.text(3))
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

    private fun inList(column: String, count: Int): String =
        column + " IN (" + List(count) { "?" }.joinToString(", ") + ")"

    /**
     * After the five named columns; see [hitsQuery]'s `with_held_thumbnail`.
     * They move together with its `select` list and nowhere else.
     */
    private const val THUMBNAIL: Int = 5
    private const val ORIGINAL_HASH: Int = 6
    private const val ORIGINAL_HELD: Int = 7

    /** Positional, as the door states. See `HomeReads.text` for why only TEXT. */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""

    private fun Row.integer(index: Int): Long = values.getOrNull(index)?.integer ?: 0L
}
