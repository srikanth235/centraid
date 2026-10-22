package dev.centraid.shared

import centraid.core.v1.AgendaSearch
import centraid.core.v1.ContainerHit
import centraid.core.v1.TasksSearch
import centraid.screen.v1.SearchAsk
import centraid.screen.v1.AgendaEmpty
import centraid.screen.v1.AgendaHomeEvent
import centraid.screen.v1.AgendaHomeState
import centraid.screen.v1.TasksProjectEvent
import dev.centraid.shared.AgendaHomeSpec.Companion.TODAY
import dev.centraid.shared.AgendaHomeSpec.Companion.context
import dev.centraid.shared.AgendaHomeSpec.Companion.drive
import dev.centraid.shared.AgendaHomeSpec.Companion.landed
import dev.centraid.shared.AgendaHomeSpec.Companion.searchOpened
import dev.centraid.shared.AgendaHomeSpec.Companion.term
import dev.centraid.shared.AgendaHomeSpec.Companion.timed
import dev.centraid.shared.AgendaHomeSpec.Companion.upcoming
import dev.centraid.shared.AgendaHomeSpec.Companion.view
import dev.centraid.shared.TasksSpec.Companion.task
import dev.centraid.shared.apps.agenda.AgendaHome
import dev.centraid.shared.apps.agenda.AgendaHomeMachine
import dev.centraid.shared.apps.agenda.AgendaInput
import dev.centraid.shared.apps.agenda.AgendaRouting
import dev.centraid.shared.apps.agenda.TasksAnswers
import dev.centraid.shared.apps.tasks.TasksProjectInput
import dev.centraid.shared.apps.tasks.TasksProjectMachine
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.ScreenIds
import dev.centraid.shared.nav.ScreenOpenings
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * AGENDA'S SEARCH FINDS PROJECTS BY NAME (#1128, Q-1128-1; #1097 R-1097-19).
 *
 * `tasks.search` answers the projects whose own name the term matched beside
 * the tasks it found. Agenda draws them as containers above the task hits —
 * the row Notes, Docs and Home's search draw — and a tap opens the project
 * page, as To-do's project row does. Monday 15 June 2026, 09:42.
 */
class AgendaSearchProjectsSpec : StringSpec({

    val schedule = AgendaHomeState.Destination.DESTINATION_SCHEDULE
    val todo = AgendaHomeState.Destination.DESTINATION_TODO

    "a term that names a project draws it as a container above the task hits" {
        val typed = drive(landed(schedule, upcoming(timed("a", "Stand-up", "2026-06-16T09:00"))), searchOpened(), term("garden")).state
        val found = answered(
            typed,
            TasksSearch(
                today = TODAY,
                tasks = listOf(task("t", "Water the garden")),
                containers = listOf(garden()),
            ),
        )
        val data = found.screen.data_.shouldNotBeNull()
        data.containers.single().let {
            it.entity shouldBe "project"
            it.id shouldBe "p-garden"
            it.app_id shouldBe "tasks"
            it.title shouldBe "Garden"
            it.kind_label shouldBe "Project"
            it.icon_key shouldBe "List"
            it.accessibility_label shouldBe "Project, Garden"
        }
        data.task_hits.single().rows.single().title shouldBe "Water the garden"
        data.empty shouldBe AgendaEmpty.AGENDA_EMPTY_NONE
        // A HIT THAT IS NO PROJECT is a plain row elsewhere, never a container here.
        val stray = answered(
            typed,
            TasksSearch(today = TODAY, containers = listOf(ContainerHit(entity = "core.collection", id = "n1", title = "Garden", app_id = "notes"))),
        )
        stray.screen.data_.shouldNotBeNull().let {
            it.containers.shouldBeEmpty()
            it.empty shouldBe AgendaEmpty.AGENDA_EMPTY_NO_MATCH
        }
        stray.screen.search_ask_row shouldBe SearchAsk(label = "Ask about “garden”", question = "Find garden", scope = "agenda")
    }

    "only a project matched: no 'nothing matches' sentence, and Ask still at the foot" {
        val typed = drive(landed(schedule), searchOpened(), term("garden")).state
        val only = answered(typed, TasksSearch(today = TODAY, containers = listOf(garden())))
        only.screen.data_.shouldNotBeNull().let {
            it.empty shouldBe AgendaEmpty.AGENDA_EMPTY_NONE
            it.empty_title shouldBe ""
            it.days.shouldBeEmpty()
            it.task_hits.shouldBeEmpty()
            it.containers.single().title shouldBe "Garden"
        }
        only.screen.search_ask_row shouldBe SearchAsk(label = "Ask about “garden”", question = "Find garden", scope = "agenda")
        // NOTHING AT ALL is no-match, with the same Ask.
        val none = answered(typed, TasksSearch(today = TODAY))
        none.screen.data_.shouldNotBeNull().let {
            it.empty shouldBe AgendaEmpty.AGENDA_EMPTY_NO_MATCH
            it.containers.shouldBeEmpty()
        }
        none.screen.search_ask_row shouldBe SearchAsk(label = "Ask about “garden”", question = "Find garden", scope = "agenda")
    }

    "closing search clears the containers, and a new term's answer replaces them" {
        val typed = drive(landed(schedule), searchOpened(), term("garden")).state
        val found = answered(typed, TasksSearch(today = TODAY, containers = listOf(garden())))
        val closed = drive(found, view(AgendaHomeEvent(search_closed = AgendaHomeEvent.SearchClosed())))
        closed.effects.shouldBeEmpty()
        closed.state.screen.data_.shouldNotBeNull().containers.shouldBeEmpty()
        val retyped = drive(found, term("kitchen")).state
        answered(retyped, TasksSearch(today = TODAY, tasks = listOf(task("k", "Kitchen tap"))))
            .screen.data_.shouldNotBeNull().containers.shouldBeEmpty()
    }

    "To-do's search draws them too" {
        val onTodo = AgendaTodoSpec.todoOn(AgendaTodoSpec.inboxBoard())
        onTodo.screen.destination shouldBe todo
        val typed = drive(onTodo, searchOpened(), term("garden")).state
        val found = AgendaHomeMachine.reduce(
            typed,
            AgendaInput.Answered(upcoming(), context(), AgendaSearch(), TasksAnswers(search = TasksSearch(today = TODAY, containers = listOf(garden())))),
        ).state
        found.screen.data_.shouldNotBeNull().let {
            it.containers.single().id shouldBe "p-garden"
            it.empty shouldBe AgendaEmpty.AGENDA_EMPTY_NONE
        }
    }

    "a tap opens the project page, named, whose back says Agenda" {
        val typed = drive(landed(schedule), searchOpened(), term("garden")).state
        val found = answered(typed, TasksSearch(today = TODAY, containers = listOf(garden())))
        val container = found.screen.data_.shouldNotBeNull().containers.single()
        val tap = AgendaHomeEvent(project_picked = AgendaHomeEvent.ProjectPicked(project_id = container.id))
        // THE MACHINE CHANGES NOTHING; the shell pushes what AgendaRouting says.
        drive(found, view(tap)).effects.shouldBeEmpty()
        val destination = AgendaRouting.home(tap, found.screen)
        destination shouldBe Destination.TasksProject("p-garden", "Garden")
        // THE SAME PAGE Home's search opens for this container (`RowRoutes`, R-1097-19).
        dev.centraid.shared.nav.RowRoutes.destination(container.target.shouldNotBeNull()) shouldBe destination
        // iOS asks for the same push, spelled.
        val opening = ScreenOpenings.of(destination!!).shouldNotBeNull()
        opening.screenId shouldBe ScreenIds.TASKS_PROJECT
        val opened = TasksProjectEvent.ADAPTER.decode(opening.event).opened.shouldNotBeNull()
        opened.project_id shouldBe "p-garden"
        opened.title shouldBe "Garden"
        val page = TasksProjectMachine.reduce(TasksProjectMachine.initial(), TasksProjectInput.View(TasksProjectEvent(opened = opened)))
        page.state.screen.chrome.shouldNotBeNull().back shouldBe "Agenda"
    }
}) {
    companion object {
        fun garden(): ContainerHit = ContainerHit(entity = "project", id = "p-garden", title = "Garden", app_id = "tasks")

        /** A search answer for the term on screen: no event, [tasks] as `tasks.search` answered it. */
        fun answered(state: AgendaHome, tasks: TasksSearch): AgendaHome =
            AgendaHomeMachine.reduce(state, AgendaInput.Answered(null, context(), AgendaSearch(), TasksAnswers(search = tasks))).state
    }
}
