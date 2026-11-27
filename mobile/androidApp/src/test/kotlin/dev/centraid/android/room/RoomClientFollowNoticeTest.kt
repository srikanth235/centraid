package dev.centraid.android.room

import centraid.core.v1.Envelope
import centraid.core.v1.FollowResponse
import centraid.core.v1.Response
import dev.centraid.core.CoreOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RoomClientFollowNoticeTest {
    @Test
    fun appearanceDeletionAndMalformedValuesReturnToTheValidSystemDefault() {
        assertEquals(RoomClient.APPEARANCE_SYSTEM, appearanceValue(found = false, json = ""))
        assertEquals(RoomClient.APPEARANCE_DARK, appearanceValue(found = true, json = "{\"value\":\"dark\"}"))
        assertEquals(RoomClient.APPEARANCE_SYSTEM, appearanceValue(found = true, json = "{\"value\":\"sepia\"}"))
        assertEquals(RoomClient.APPEARANCE_SYSTEM, appearanceValue(found = true, json = "not-json"))
    }

    @Test
    fun declinedStoreReadUsesTheCoreSentence() {
        val sentence = "The phone store could not be read. Try again."
        val outcome = CoreOutcome.Answered(
            Envelope(response = Response(follow = FollowResponse(declined = true, sentence = sentence))),
        )

        assertEquals(sentence, followNotice(outcome))
    }

    @Test
    fun aCoreStatusSentenceIsShownAndNoSentenceDoesNotInventOne() {
        val status = "Photo access is on. New photos have not been checked yet."
        assertEquals(
            status,
            followNotice(CoreOutcome.Answered(Envelope(response = Response(follow = FollowResponse(sentence = status))))),
        )
        assertNull(followNotice(CoreOutcome.Answered(Envelope(response = Response(follow = FollowResponse())))))
        assertNull(followNotice(CoreOutcome.Failed(dev.centraid.core.CoreFailure.Closed)))
    }
}
