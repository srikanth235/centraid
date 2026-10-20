package dev.centraid.android.kit

import org.junit.Assert.assertEquals
import org.junit.Test

/** THE IDS AND ORIGINS ANDROID'S READERS PRODUCE (R-1127-10): each says which kind of id it is. */
class PhoneOriginsTest {
    @Test
    fun aContactIsKeyedByItsLookupKeyAndFallsBackToTheRowId() {
        assertEquals("lookup:0r1-2B3C", PhoneOrigins.contactId("0r1-2B3C", 7))
        assertEquals("local:7", PhoneOrigins.contactId(null, 7))
        assertEquals("local:7", PhoneOrigins.contactId("  ", 7))
    }

    @Test
    fun anEventIsKeyedByItsUidAndFallsBackToTheRowId() {
        assertEquals("uid:abc123@google.com", PhoneOrigins.eventId("abc123@google.com", 9))
        assertEquals("local:9", PhoneOrigins.eventId(null, 9))
        assertEquals("local:9", PhoneOrigins.eventId("", 9))
    }

    @Test
    fun anAccountIsTypeAndNameAndNoAccountIsLocal() {
        assertEquals("account:com.google/ada@example.com", PhoneOrigins.accountId("com.google", "ada@example.com"))
        assertEquals("account:local", PhoneOrigins.accountId(null, null))
        assertEquals("account:local", PhoneOrigins.accountId("", ""))
    }

    @Test
    fun aCalendarIsKeyedByItsSyncIdElseItsRowId() {
        assertEquals(
            "calendar:com.google/ada@example.com/ada@example.com",
            PhoneOrigins.calendarId("com.google", "ada@example.com", "ada@example.com", 3),
        )
        assertEquals("calendar:LOCAL/Me/3", PhoneOrigins.calendarId("LOCAL", "Me", null, 3))
    }

    @Test
    fun labelsNameWhatTheMemberKnows() {
        assertEquals("Google: ada@example.com", PhoneOrigins.accountLabel("Google", "ada@example.com"))
        assertEquals("ada@example.com", PhoneOrigins.accountLabel("", "ada@example.com"))
        assertEquals("ada@example.com: Work", PhoneOrigins.calendarLabel("ada@example.com", "Work"))
        assertEquals("Work", PhoneOrigins.calendarLabel(null, "Work"))
    }
}
