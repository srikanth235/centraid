package dev.centraid.shared.apps.docs

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.DocsDriveRequest
import centraid.core.v1.DocsModifiedFilter
import centraid.core.v1.DocsSearchRequest
import centraid.core.v1.DocsShelf
import centraid.core.v1.DocsSort
import centraid.core.v1.DocsTypeFilter
import centraid.screen.v1.DocsDriveEvent
import centraid.screen.v1.DocsDriveState
import centraid.screen.v1.DocsQuery
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT THE DRIVE ASKS THE CORE (#1046, docs port), and what its writes answer.
 *
 * One query per read: `docs.drive` for the shelf — its folder, filters and
 * order as the request — or `docs.search` while a term is typed. Recently
 * added is a WINDOW, not a filter, so it carries none. The zone is the
 * device's, read at every read.
 */
public object DocsDriveReads :
    ScreenQueries<DocsDriveState, DocsDriveEvent>,
    ScreenWrites<DocsDriveState, DocsDriveEvent> {
    override val screenId: String = DocsDriveMachine.SCREEN_ID

    override val tables: Set<String> = DocsDriveMachine.TABLES

    override val appId: String = DocsWrites.APP_ID

    /** `docs.search`'s own ceiling. */
    public const val SEARCH_LIMIT: Int = 100

    override fun requests(state: DocsDriveState, now: DeviceClock.Reading): List<AppQueryRequest> {
        val term = DocsDriveMachine.activeTerm(state)
        if (term != null) {
            return listOf(
                AppQueryRequest(docs_search = DocsSearchRequest(term = term, limit = SEARCH_LIMIT, tz = now.zone)),
            )
        }
        return listOf(AppQueryRequest(docs_drive = driveRequest(state, now.zone)))
    }

    /** The shelf as the core's request. */
    public fun driveRequest(state: DocsDriveState, zone: String): DocsDriveRequest {
        val query = state.query ?: DocsQuery()
        val shelf = when (state.destination) {
            DocsDriveState.Destination.DESTINATION_FOLDERS -> DocsShelf.DOCS_SHELF_FOLDER
            DocsDriveState.Destination.DESTINATION_STARRED -> DocsShelf.DOCS_SHELF_STARRED
            DocsDriveState.Destination.DESTINATION_RECENT -> DocsShelf.DOCS_SHELF_RECENT
            else -> DocsShelf.DOCS_SHELF_ALL
        }
        if (shelf == DocsShelf.DOCS_SHELF_RECENT) return DocsDriveRequest(shelf = shelf, tz = zone)
        return DocsDriveRequest(
            shelf = shelf,
            folder_id = if (shelf == DocsShelf.DOCS_SHELF_FOLDER) state.folder_id else "",
            type = typeOf(query.type),
            modified = modifiedOf(query.modified),
            label = query.label,
            sort = sortOf(query.sort),
            ascending = query.ascending,
            tz = zone,
        )
    }

    /** By arm, not by position: the request depends on the state. */
    override fun arrived(answers: List<AppQueryResponse>): DocsDriveEvent {
        answers.firstNotNullOfOrNull { it.docs_search }?.let { search ->
            return DocsDriveEvent(data_ = DocsDriveEvent.DataArrived(data_ = DocsFold.search(search)))
        }
        val drive = answers.firstNotNullOfOrNull { it.docs_drive }
            ?: return refused(Reads.refused(NO_ANSWER))
        return DocsDriveEvent(
            data_ = DocsDriveEvent.DataArrived(data_ = DocsFold.shelf(drive), rail = DocsFold.rail(drive)),
        )
    }

    override fun refused(failure: ReadFailure): DocsDriveEvent =
        DocsDriveEvent(refused = DocsDriveEvent.ReadRefused(failure = failure))

    /** The gate's words, not a refusal: no band, nothing drawn behind it. */
    override fun denied(denial: AppQueryDenial): DocsDriveEvent = DocsDriveEvent(denied = DocsDriveMachine.deniedOf())

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): DocsDriveEvent =
        DocsDriveEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey))

    internal fun typeOf(type: DocsQuery.TypeFilter): DocsTypeFilter = when (type) {
        DocsQuery.TypeFilter.TYPE_FILTER_PDF -> DocsTypeFilter.DOCS_TYPE_FILTER_PDF
        DocsQuery.TypeFilter.TYPE_FILTER_IMAGE -> DocsTypeFilter.DOCS_TYPE_FILTER_IMAGE
        DocsQuery.TypeFilter.TYPE_FILTER_WORD -> DocsTypeFilter.DOCS_TYPE_FILTER_WORD
        DocsQuery.TypeFilter.TYPE_FILTER_SPREADSHEET -> DocsTypeFilter.DOCS_TYPE_FILTER_SPREADSHEET
        DocsQuery.TypeFilter.TYPE_FILTER_MARKDOWN -> DocsTypeFilter.DOCS_TYPE_FILTER_MARKDOWN
        DocsQuery.TypeFilter.TYPE_FILTER_TEXT -> DocsTypeFilter.DOCS_TYPE_FILTER_TEXT
        DocsQuery.TypeFilter.TYPE_FILTER_AUDIO -> DocsTypeFilter.DOCS_TYPE_FILTER_AUDIO
        DocsQuery.TypeFilter.TYPE_FILTER_VIDEO -> DocsTypeFilter.DOCS_TYPE_FILTER_VIDEO
        else -> DocsTypeFilter.DOCS_TYPE_FILTER_UNSPECIFIED
    }

    internal fun modifiedOf(modified: DocsQuery.Modified): DocsModifiedFilter = when (modified) {
        DocsQuery.Modified.MODIFIED_TODAY -> DocsModifiedFilter.DOCS_MODIFIED_FILTER_TODAY
        DocsQuery.Modified.MODIFIED_LAST_7_DAYS -> DocsModifiedFilter.DOCS_MODIFIED_FILTER_LAST_7_DAYS
        DocsQuery.Modified.MODIFIED_LAST_30_DAYS -> DocsModifiedFilter.DOCS_MODIFIED_FILTER_LAST_30_DAYS
        DocsQuery.Modified.MODIFIED_THIS_YEAR -> DocsModifiedFilter.DOCS_MODIFIED_FILTER_THIS_YEAR
        else -> DocsModifiedFilter.DOCS_MODIFIED_FILTER_UNSPECIFIED
    }

    internal fun sortOf(sort: DocsQuery.Sort): DocsSort = when (sort) {
        DocsQuery.Sort.SORT_NAME -> DocsSort.DOCS_SORT_NAME
        DocsQuery.Sort.SORT_KIND -> DocsSort.DOCS_SORT_KIND
        DocsQuery.Sort.SORT_SIZE -> DocsSort.DOCS_SORT_SIZE
        else -> DocsSort.DOCS_SORT_CHANGED
    }

    private const val NO_ANSWER: String = "The vault answered without the drive."
}
