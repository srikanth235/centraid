package dev.centraid.android.kit

import androidx.health.connect.client.records.ExerciseSessionRecord
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * HEALTH CONNECT'S EXERCISE TYPES BY NAME (#1129). The Android half of iOS's
 * `testKindNamesFallBackToOther`: a type the table knows is spelled as the store's constant, one it
 * does not know is "other workout" (never a number, never an empty word).
 */
class ExerciseNamesTest {
    @Test
    fun aKnownTypeIsItsConstantsNameAndAnUnknownOneIsOtherWorkout() {
        assertEquals("EXERCISE_TYPE_RUNNING", ExerciseNames.name(ExerciseSessionRecord.EXERCISE_TYPE_RUNNING))
        assertEquals(
            "EXERCISE_TYPE_STRENGTH_TRAINING",
            ExerciseNames.name(ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING),
        )
        assertEquals("EXERCISE_TYPE_OTHER_WORKOUT", ExerciseNames.name(Int.MAX_VALUE))
        assertEquals("EXERCISE_TYPE_OTHER_WORKOUT", ExerciseNames.name(-1))
    }
}
