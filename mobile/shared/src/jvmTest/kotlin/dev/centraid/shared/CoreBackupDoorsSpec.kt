package dev.centraid.shared

import centraid.core.v1.BackupStatusResponse
import centraid.core.v1.Destination
import centraid.core.v1.DrainResponse
import centraid.core.v1.DrainStop
import centraid.core.v1.Envelope
import centraid.core.v1.ErrorCode
import centraid.core.v1.FetchOriginalResponse
import centraid.core.v1.FetchOutcome
import centraid.core.v1.ForgetDestinationResponse
import centraid.core.v1.HandoffPart as WireHandoffPart
import centraid.core.v1.HandoffResponse
import centraid.core.v1.Header
import centraid.core.v1.NeedBytes
import centraid.core.v1.ReconcileResponse
import centraid.core.v1.Releasable
import centraid.core.v1.ReleasableResponse
import centraid.core.v1.ReleasedResponse
import centraid.core.v1.Request
import centraid.core.v1.Response
import centraid.core.v1.SettleResponse
import centraid.core.v1.Settled
import centraid.core.v1.StageBegun
import centraid.core.v1.StageHandle
import centraid.core.v1.StageResponse
import centraid.core.v1.StageSource
import centraid.core.v1.WaitReason as WireWaitReason
import centraid.core.v1.Waiting
import dev.centraid.core.CentraidCore
import dev.centraid.shared.shell.Staging
import dev.centraid.shared.sync.ContentHash
import dev.centraid.shared.sync.CoreBackupDoors
import dev.centraid.shared.sync.CoreBackupStatus
import dev.centraid.shared.sync.CoreDrainDoor
import dev.centraid.shared.sync.CoreFreeUpDoors
import dev.centraid.shared.sync.DrainAnswer
import dev.centraid.shared.sync.DrainInput
import dev.centraid.shared.sync.FetchedOriginal
import dev.centraid.shared.sync.ForgetAnswer
import dev.centraid.shared.sync.LedgerChange
import dev.centraid.shared.sync.ReleasableItem
import dev.centraid.shared.sync.TransferRule
import dev.centraid.shared.sync.WaitReason
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import okio.ByteString.Companion.toByteString

/**
 * THE BACKUP PLANE'S DOORS, OVER A SCRIPTED CORE (#1080, the wire contract).
 *
 * Each door is one envelope out and one `when` back; these cases hold what
 * crosses in each direction — the member's rule and the link going out, the
 * gateway's clock and the core's counts coming back — and that every refusal,
 * `NOT_YET_AVAILABLE` included, reads as "no answer" and never as a fact.
 */
class CoreBackupDoorsSpec : StringSpec({

    val hash = "ab".repeat(32)

    fun core(seen: MutableList<Request> = mutableListOf(), answer: (Request) -> Envelope): CentraidCore =
        CentraidCore.answering(Dispatchers.Unconfined) { envelope ->
            val request = envelope.request!!
            seen += request
            answer(request)
        }

    fun refusing(code: ErrorCode) = core { Envelope(error = centraid.core.v1.Error(code = code, detail = "logs only")) }

    "the pass carries the rule, the link, the snapshot and the videos' negation" {
        runTest {
            val seen = mutableListOf<Request>()
            val door = CoreDrainDoor {
                core(seen) { Envelope(response = Response(drain = DrainResponse(stopped = DrainStop.DRAIN_STOP_EMPTY))) }
            }
            door.drain(
                DrainInput(
                    deadlineMs = 25_000,
                    rule = TransferRule.WIFI_AND_CELLULAR_PHOTOS,
                    includeVideos = false,
                    metered = true,
                    charging = false,
                    wantsSnapshot = true,
                    asked = true,
                ),
            )
            val sent = seen.single().drain.shouldNotBeNull()
            sent.deadline_ms shouldBe 25_000L
            sent.rule shouldBe centraid.core.v1.TransferRule.TRANSFER_RULE_WIFI_AND_CELLULAR_PHOTOS
            sent.metered shouldBe true
            sent.charging shouldBe false
            sent.wants_snapshot shouldBe true
            // THE MEMBER'S TAP CROSSES AS ITS OWN BIT (#1080 A24).
            sent.asked shouldBe true
            // INCLUDED IS THE ZERO VALUE: the wire's default is the complete backup.
            sent.exclude_videos shouldBe true
            // A SNAPSHOT NOBODY ASKED FOR carries no ask: leaving the screen.
            door.drain(
                DrainInput(0, TransferRule.MANUAL, true, metered = false, charging = false, wantsSnapshot = true),
            )
            seen.last().drain.shouldNotBeNull().asked shouldBe false
        }
    }

    "the pass's answer keeps the gateway's clock and turns raw hashes into hex" {
        runTest {
            val door = CoreDrainDoor {
                core {
                    Envelope(
                        response = Response(
                            drain = DrainResponse(
                                pending_bytes = 900,
                                stopped = DrainStop.DRAIN_STOP_DEADLINE,
                                acked_at_ms = 1_790_000_000_000,
                                confirmed_parts = 12,
                                waiting_bytes_parts = 3,
                                need_bytes = listOf(
                                    NeedBytes(content_hash = ContentHash.raw(hash)!!, os_ref = "L/1", media_type = "image/heic", size = 7),
                                    // A HASH OF THE WRONG LENGTH IS DROPPED, never streamed against.
                                    NeedBytes(content_hash = ByteArray(3).toByteString(), os_ref = "L/2"),
                                ),
                            ),
                        ),
                    )
                }
            }
            val answer = door.drain(
                DrainInput(0, TransferRule.WIFI_ONLY, true, metered = false, charging = true, wantsSnapshot = false),
            ).shouldNotBeNull()
            answer.stopped shouldBe DrainAnswer.Stopped.DEADLINE
            answer.ackedAtMs shouldBe 1_790_000_000_000L
            answer.confirmedParts shouldBe 12
            answer.waitingBytesParts shouldBe 3
            answer.needBytes.map { it.contentHash to it.osRef } shouldBe listOf(hash to "L/1")
        }
    }

    "a moved vault is an answer, dated by the gateway; every other refusal is no pass" {
        runTest {
            val moved = CoreDrainDoor {
                core {
                    Envelope(
                        error = centraid.core.v1.Error(
                            code = ErrorCode.ERROR_CODE_VAULT_MOVED,
                            moved = centraid.core.v1.VaultMoved(moved_at_ms = 1_789_000_000_000),
                        ),
                    )
                }
            }.drain(DrainInput(0, TransferRule.WIFI_ONLY, true, false, true, false)).shouldNotBeNull()
            moved.stopped shouldBe DrainAnswer.Stopped.MOVED
            moved.movedAtMs shouldBe 1_789_000_000_000L
            CoreDrainDoor { refusing(ErrorCode.ERROR_CODE_INVALID_REQUEST) }
                .drain(DrainInput(0, TransferRule.WIFI_ONLY, true, false, true, false)).shouldBeNull()
        }
    }

    "the status reads the core's ledger: destinations, counts and why the rest waits" {
        runTest {
            val reading = CoreBackupStatus {
                core {
                    Envelope(
                        response = Response(
                            backup_status = BackupStatusResponse(
                                acked_at_ms = 1_790_000_000_000,
                                pending_bytes = 40,
                                destinations = listOf(
                                    Destination(gateway_id = "gw-1", label = "Home laptop", addrs = listOf("192.168.1.20:7443"), last_seen_ms = 5, last_ack_ms = 0),
                                ),
                                last_snapshot_ms = 1_789_999_000_000,
                                content_total = 10,
                                content_confirmed = 7,
                                spool_bytes = 4_096,
                                waiting = listOf(
                                    Waiting(reason = WireWaitReason.WAIT_REASON_WIFI, count = 2),
                                    Waiting(reason = WireWaitReason.WAIT_REASON_ICLOUD, count = 1),
                                    Waiting(reason = WireWaitReason.WAIT_REASON_ASK, count = 4),
                                    Waiting(reason = WireWaitReason.WAIT_REASON_UNTRUSTED, count = 3),
                                    Waiting(reason = WireWaitReason.WAIT_REASON_UNSPECIFIED, count = 9),
                                ),
                                frozen = false,
                            ),
                        ),
                    )
                }
            }.read().shouldNotBeNull()
            reading.lastAckMs shouldBe 1_790_000_000_000L
            reading.lastSnapshotMs shouldBe 1_789_999_000_000L
            reading.unconfirmed shouldBe 3L
            reading.spoolBytes shouldBe 4_096L
            // LANE C'S TWO REASONS ARE READ TOO (#1080 A24, the pinned gateway).
            reading.waiting shouldBe mapOf(
                WaitReason.WIFI to 2L,
                WaitReason.ICLOUD to 1L,
                WaitReason.ASK to 4L,
                WaitReason.UNTRUSTED to 3L,
            )
            val destination = reading.destinations.single()
            destination.gatewayId shouldBe "gw-1"
            destination.lastSeenMs shouldBe 5L
            // ZERO IS "NEVER" ON THE WIRE.
            destination.lastAckMs.shouldBeNull()
        }
    }

    "a handoff is passed to the shell whole: the core's part is the upload, headers and all" {
        runTest {
            val parts = CoreBackupDoors {
                core {
                    Envelope(
                        response = Response(
                            handoff = HandoffResponse(
                                parts = listOf(
                                    WireHandoffPart(
                                        name = hash,
                                        path = "/spool/$hash",
                                        url = "https://192.168.1.20:7443/v2/v/vlt/o/$hash",
                                        method = "PUT",
                                        headers = listOf(Header("Content-Digest", "blake3=00")),
                                        size = 1_024,
                                        gateway_id = "gw-1",
                                        vault_id = "vlt",
                                        allows_cellular = true,
                                    ),
                                ),
                            ),
                        ),
                    )
                }
            }.handoff(maxBytes = 50_000_000, maxParts = 32).shouldNotBeNull()
            // NOTHING IS RE-SPELLED ON THE WAY: the core's cellular verdict for
            // the part (A10's `allows_cellular`) reaches the mover as the core
            // set it, without this door reading it.
            val part = parts.single()
            part.allows_cellular shouldBe true
            part.headers.single().value_ shouldBe "blake3=00"
            part.gateway_id shouldBe "gw-1"
            part.vault_id shouldBe "vlt"
            part.size shouldBe 1_024L
        }
    }

    "settle, reconcile and forget cross both ways, and NOT_YET_AVAILABLE is no answer" {
        runTest {
            val seen = mutableListOf<Request>()
            val doors = CoreBackupDoors {
                core(seen) { request ->
                    when {
                        request.settle != null -> Envelope(response = Response(settle = SettleResponse(confirmed = 1, requeued = 1)))
                        request.reconcile != null -> Envelope(response = Response(reconcile = ReconcileResponse(confirmed = 2, reachable = false)))
                        else -> Envelope(
                            response = Response(forget_destination = ForgetDestinationResponse(forgotten = true, revoked = true)),
                        )
                    }
                }
            }
            doors.settle(listOf(Settled(name = hash, http_status = 201, gateway_id = "gw-1", vault_id = "vlt"))) shouldBe
                LedgerChange(1, 1)
            val settled = seen.single().settle!!.settled.single()
            settled.http_status shouldBe 201
            settled.vault_id shouldBe "vlt"
            doors.reconcile() shouldBe LedgerChange(confirmed = 2, requeued = 0, reachable = false)
            doors.forget("gw-1") shouldBe ForgetAnswer(forgotten = true, revoked = true)
            seen.last().forget_destination!!.gateway_id shouldBe "gw-1"
            val unready = CoreBackupDoors { refusing(ErrorCode.ERROR_CODE_NOT_YET_AVAILABLE) }
            unready.handoff(1, 1).shouldBeNull()
            unready.reconcile().shouldBeNull()
            unready.forget("gw-1").shouldBeNull()
            unready.fetchOriginal(hash).shouldBeNull()
            CoreBackupDoors { null }.pins().shouldBeNull()
        }
    }

    "a stage from the library names where the bytes live; a derivative names its original" {
        runTest {
            val seen = mutableListOf<Request>()
            val stager = core(seen) { request ->
                val stage = request.stage!!
                Envelope(
                    response = Response(
                        stage = when {
                            stage.begin != null -> StageResponse(begun = StageBegun(staging_id = "s", chunk_bytes = 4))
                            stage.chunk != null -> StageResponse()
                            else -> StageResponse(handle = StageHandle(content_hash = hash, byte_size = 6))
                        },
                    ),
                )
            }
            val bytes = "abcdef".encodeToByteArray()
            var at = 0
            Staging.stage(
                stager,
                "image/heic",
                byteSize = 0,
                source = Staging.Source.OS_LIBRARY,
                osRef = "L/1",
                osEdited = true,
            ) { max ->
                bytes.copyOfRange(at, minOf(at + max, bytes.size)).also { at += it.size }
            }.shouldBeInstanceOf<Staging.Outcome.Ok>()
            val begin = seen.first().stage!!.begin!!
            begin.source shouldBe StageSource.STAGE_SOURCE_OS_LIBRARY
            begin.os_ref shouldBe "L/1"
            begin.byte_size shouldBe 0L
            // AN EDITED LIBRARY ITEM SAYS SO (A20), so the core never offers it
            // for deletion.
            begin.os_edited shouldBe true
            seen.clear()
            at = 0
            Staging.stage(stager, "image/jpeg", 6, forHash = hash, tier = "thumb", osEdited = true) { max ->
                bytes.copyOfRange(at, minOf(at + max, bytes.size)).also { at += it.size }
            }
            val derivative = seen.first().stage!!.begin!!
            derivative.source shouldBe StageSource.STAGE_SOURCE_OWNED
            derivative.for_hash shouldBe ContentHash.raw(hash)
            derivative.tier shouldBe "thumb"
            // AN OWNED FILE IS NO LIBRARY ITEM: the edit mark is never sent with it.
            derivative.os_edited shouldBe false
        }
    }

    "a forgotten gateway that was not told reads forgotten and not revoked" {
        runTest {
            CoreBackupDoors {
                core { Envelope(response = Response(forget_destination = ForgetDestinationResponse(forgotten = true))) }
            }.forget("gw-1") shouldBe ForgetAnswer(forgotten = true, revoked = false)
        }
    }

    "every fetch outcome on the wire reads as its own outcome, the two lane C added included" {
        runTest {
            val rows = mapOf(
                FetchOutcome.FETCH_OUTCOME_LANDED to FetchedOriginal.LANDED,
                FetchOutcome.FETCH_OUTCOME_ALREADY_HELD to FetchedOriginal.ALREADY_HELD,
                FetchOutcome.FETCH_OUTCOME_UNREACHABLE to FetchedOriginal.UNREACHABLE,
                FetchOutcome.FETCH_OUTCOME_NOT_IN_BACKUP to FetchedOriginal.NOT_IN_BACKUP,
                FetchOutcome.FETCH_OUTCOME_UNTRUSTED to FetchedOriginal.UNTRUSTED,
                FetchOutcome.FETCH_OUTCOME_DAMAGED to FetchedOriginal.DAMAGED,
                FetchOutcome.FETCH_OUTCOME_UNSPECIFIED to FetchedOriginal.UNREACHABLE,
            )
            rows.keys shouldBe FetchOutcome.entries.toSet()
            for ((wire, outcome) in rows) {
                CoreBackupDoors {
                    core { Envelope(response = Response(fetch_original = FetchOriginalResponse(outcome = wire))) }
                }.fetchOriginal(hash).shouldNotBeNull().first shouldBe outcome
            }
        }
    }

    "a pass that met a machine that is not the gateway says so, and an unknown stop is unreachable" {
        runTest {
            fun stopped(stop: DrainStop) = CoreDrainDoor {
                core { Envelope(response = Response(drain = DrainResponse(stopped = stop))) }
            }
            stopped(DrainStop.DRAIN_STOP_UNTRUSTED)
                .drain(DrainInput(0, TransferRule.WIFI_ONLY, true, false, true, false)).shouldNotBeNull()
                .stopped shouldBe DrainAnswer.Stopped.UNTRUSTED
            stopped(DrainStop.DRAIN_STOP_UNSPECIFIED)
                .drain(DrainInput(0, TransferRule.WIFI_ONLY, true, false, true, false)).shouldNotBeNull()
                .stopped shouldBe DrainAnswer.Stopped.UNREACHABLE
        }
    }

    "free up's two doors cross both ways, and a refusal is no list and no record" {
        runTest {
            val seen = mutableListOf<Request>()
            val raw = ByteArray(32) { 0xab.toByte() }
            val doors = CoreFreeUpDoors {
                core(seen) { request ->
                    if (request.releasable != null) {
                        Envelope(
                            response = Response(
                                releasable = ReleasableResponse(
                                    items = listOf(
                                        Releasable(
                                            content_hash = raw.toByteString(),
                                            os_ref = "L/1",
                                            size = 2_048,
                                            media_type = "image/heic",
                                        ),
                                    ),
                                    total_bytes = 2_048,
                                ),
                            ),
                        )
                    } else {
                        Envelope(response = Response(released = ReleasedResponse(recorded = 1)))
                    }
                }
            }
            val list = doors.releasable(1_000).shouldNotBeNull()
            seen.single().releasable!!.limit shouldBe 1_000L
            list.totalBytes shouldBe 2_048L
            list.items shouldBe listOf(ReleasableItem(raw, "L/1", 2_048, "image/heic"))
            list.items.single().hex shouldBe hash
            // ONLY WHAT THE PLATFORM DELETED IS REPORTED, by raw content hash.
            doors.released(listOf(raw)) shouldBe 1
            seen.last().released!!.content_hash shouldBe listOf(raw.toByteString())
            val refused = CoreFreeUpDoors { refusing(ErrorCode.ERROR_CODE_NOT_YET_AVAILABLE) }
            refused.releasable(1).shouldBeNull()
            refused.released(listOf(raw)).shouldBeNull()
            CoreFreeUpDoors { null }.releasable(1).shouldBeNull()
        }
    }
})
