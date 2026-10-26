package app.corkboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NowTest {
    private val plan = Plan(
        date = "2026-10-25",
        version = 3,
        day = Day(
            listOf(
                Block("med", 510, 540, "Meditate", "work"),
                Block("mobile", 540, 660, "Mobile: day plan walkthrough", "work", card = "TASK-21"),
                Block("lunch", 720, 780, "Lunch", "fixed"),
                Block("ctx", 780, 840, "Context warning", "work"),
            ),
        ),
        accepted = "2026-10-25T15:16:00Z",
    )

    @Test
    fun theBlockNowIncludesItsStartButNotItsEnd() {
        assertEquals("mobile", Now.current(plan, 540)?.id)
        assertEquals("mobile", Now.current(plan, 659)?.id)
        assertNull(Now.current(plan, 660))
        assertNull(Now.current(null, 600))
    }

    @Test
    fun nextIsWhatStartsLater() {
        assertEquals(listOf("lunch", "ctx"), Now.next(plan, 600, 3).map { it.id })
        assertEquals(listOf("lunch"), Now.next(plan, 600, 1).map { it.id })
        assertEquals(emptyList<Block>(), Now.next(plan, 900))
    }

    @Test
    fun timesReadAsTheDesktopShowsThem() {
        assertEquals("09:00", clock(540))
        assertEquals("00:00", clock(1440))
        assertEquals("45m", length(45))
        assertEquals("2h", length(120))
        assertEquals("1h12", length(72))
    }

    @Test
    fun aWorkerPlanDecodesWithFieldsThePhoneDoesntUse() {
        val json = """{"date":"2026-10-25","version":2,"projects":[],"day":{"blocks":[{"id":"a","start":60,"stop":120,
            "title":"Jobs: a","kind":"work","pinned":true}],"ranked":[],"later":[],"inputs":[]},
            "proposal":{"from":0,"blocks":[],"reasons":[{"text":"first plan"}],"why":{},"made":"x","by":"pepper","answering":[]},
            "asked":[],"accepted":null}"""
        val p = Cloud.json.decodeFromString(Plan.serializer(), json)
        assertEquals(true, p.day.blocks[0].pinned)
        assertEquals("first plan", p.proposal!!.reasons[0].text)
        assertNull(p.accepted)
    }
}
