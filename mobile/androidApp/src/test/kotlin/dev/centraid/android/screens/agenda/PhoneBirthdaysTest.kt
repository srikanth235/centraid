package dev.centraid.android.screens.agenda

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** THE BIRTHDAYS CALENDAR IS THE ONE CALENDAR NOT FOLLOWED; read-only and subscribed ones are. */
class PhoneBirthdaysTest {
    @Test
    fun googlesContactBirthdaysCalendarIsRecognised() {
        assertTrue(PhoneBirthdays.isBirthdays("com.google", "addressbook#contacts@group.v.calendar.google.com"))
    }

    @Test
    fun otherCalendarsAreFollowedWhateverTheirName() {
        assertFalse(PhoneBirthdays.isBirthdays("com.google", "en.uk#holiday@group.v.calendar.google.com"))
        assertFalse(PhoneBirthdays.isBirthdays("com.google", "team@example.com"))
        assertFalse(PhoneBirthdays.isBirthdays("LOCAL", null))
        assertFalse(PhoneBirthdays.isBirthdays(null, "addressbook#contacts@group.v.calendar.google.com"))
    }
}
