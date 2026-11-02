package app.corkboard.e2ee

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

// Merging an object's ops, once opened (lib/e2ee/merge.ts): each record's
// field is the value of the latest write to it, latest by a Lamport clock,
// then device, then op id; a record's log only grows, kept by op id and
// read in clock order. A board's records are its cards; a brain's are
// `brain`, `note:<id>` and `entry:<id>`; the index's, one per object.
//
// This follows merge.ts's quirks too (a record made by an op it then
// refuses, JS's own key order in cards()), since two replicas' cards must
// be the same JSON exactly when their states are.

data class Stamp(val clock: Long, val device: String, val op: String) : Comparable<Stamp> {
    override fun compareTo(other: Stamp): Int =
        clock.compareTo(other.clock).takeIf { it != 0 } ?: device.compareTo(other.device).takeIf { it != 0 } ?: op.compareTo(other.op)

    fun toJson() = JsonObject(mapOf("clock" to JsonPrimitive(clock), "device" to JsonPrimitive(device), "op" to JsonPrimitive(op)))

    companion object {
        fun from(o: JsonObject) = Stamp(o.long("clock"), o.str("device"), o.str("op"))
    }
}

data class LogEntry(val at: String, val who: String, val note: String) {
    fun toJson() = JsonObject(mapOf("at" to JsonPrimitive(at), "who" to JsonPrimitive(who), "note" to JsonPrimitive(note)))
}

// What an op says, inside its encryption. Set: fields of a record (anything
// but log); Log: one entry onto it.
sealed class CardChange(val card: String) {
    class Set(card: String, val set: Map<String, JsonElement>) : CardChange(card)
    class Log(card: String, val entry: LogEntry) : CardChange(card)

    fun toJson(): JsonObject = when (this) {
        is Set -> JsonObject(mapOf("t" to JsonPrimitive("card"), "card" to JsonPrimitive(card), "set" to JsonObject(set)))
        is Log -> JsonObject(mapOf("t" to JsonPrimitive("log"), "card" to JsonPrimitive(card), "entry" to entry.toJson()))
    }
}

fun opJson(clock: Long, device: String, change: CardChange) =
    JsonObject(mapOf("v" to JsonPrimitive(1), "clock" to JsonPrimitive(clock), "device" to JsonPrimitive(device), "change" to change.toJson()))

class FieldState(val value: JsonElement, val stamp: Stamp)
class LogItem(val stamp: Stamp, val entry: LogEntry)
class CardState(val fields: LinkedHashMap<String, FieldState> = LinkedHashMap(), val log: LinkedHashMap<String, LogItem> = LinkedHashMap())

class BoardState(val cards: LinkedHashMap<String, CardState> = LinkedHashMap(), var clock: Long = 0) {
    // As merge.ts's BoardState is JSON: what a snapshot holds.
    fun toJson(): JsonObject = JsonObject(
        mapOf(
            "cards" to JsonObject(
                cards.mapValues { (_, c) ->
                    JsonObject(
                        mapOf(
                            "fields" to JsonObject(c.fields.mapValues { (_, f) -> JsonObject(mapOf("value" to f.value, "stamp" to f.stamp.toJson())) }),
                            "log" to JsonObject(c.log.mapValues { (_, l) -> JsonObject(mapOf("stamp" to l.stamp.toJson(), "entry" to l.entry.toJson())) }),
                        ),
                    )
                },
            ),
            "clock" to JsonPrimitive(clock),
        ),
    )

    fun copy(): BoardState = from(toJson())!!

    companion object {
        // Null if it isn't a state at all.
        fun from(e: JsonElement): BoardState? = runCatching {
            val o = e.jsonObject
            val clock = safeInt(o["clock"]) ?: return null
            val s = BoardState(clock = clock)
            for ((id, c) in o["cards"]!!.jsonObject) {
                val co = c.jsonObject
                val card = CardState()
                for ((k, f) in (co["fields"] as? JsonObject).orEmpty()) {
                    val fo = f.jsonObject
                    card.fields[k] = FieldState(fo["value"] ?: JsonNull, Stamp.from(fo["stamp"]!!.jsonObject))
                }
                for ((k, l) in (co["log"] as? JsonObject).orEmpty()) {
                    val lo = l.jsonObject
                    val en = lo["entry"]!!.jsonObject
                    card.log[k] = LogItem(Stamp.from(lo["stamp"]!!.jsonObject), LogEntry(jsText(en["at"]), jsText(en["who"]), jsText(en["note"])))
                }
                s.cards[id] = card
            }
            s
        }.getOrNull()
    }
}

// A record's id: a card's, or a brain's note:<id> and entry:<id>.
private val CARD = Regex("[\\w.:-]{1,64}")
private const val MAX_SAFE = 9007199254740991.0

// Number.isSafeInteger, of a JSON value.
internal fun safeInt(e: JsonElement?): Long? {
    val p = e as? JsonPrimitive ?: return null
    if (p.isString || p is JsonNull) return null
    p.longOrNull?.let { return it.takeIf { kotlin.math.abs(it.toDouble()) <= MAX_SAFE } }
    val d = p.doubleOrNull ?: return null
    return if (d.isFinite() && d == Math.floor(d) && kotlin.math.abs(d) <= MAX_SAFE) d.toLong() else null
}

// String(x), for the JSON values a log entry's at and who might be.
internal fun jsText(e: JsonElement?): String = when {
    e == null || e is JsonNull -> ""
    e is JsonPrimitive && e.isString -> e.content
    e is JsonPrimitive && e.booleanOrNull != null -> e.content
    e is JsonPrimitive -> safeInt(e)?.toString() ?: e.content
    e is JsonArray -> e.joinToString(",") { if (it is JsonNull) "" else jsText(it) }
    else -> "[object Object]"
}

fun empty() = BoardState()

// Applies one op (opened, with its id); false if it's not one this
// understands, which is skipped, not fatal: a newer client may write more.
fun apply(state: BoardState, id: String, op: JsonElement): Boolean {
    val o = op as? JsonObject ?: return false
    val v = o["v"] as? JsonPrimitive
    if (v == null || v.isString || v.doubleOrNull != 1.0) return false
    val clock = safeInt(o["clock"]) ?: return false
    if (clock < 0) return false
    val device = (o["device"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return false
    val c = o["change"] as? JsonObject ?: return false
    val cardId = (c["card"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return false
    if (!CARD.matches(cardId)) return false
    val stamp = Stamp(clock, device, id)
    state.clock = maxOf(state.clock, clock)
    val card = state.cards.getOrPut(cardId) { CardState() }
    when ((c["t"] as? JsonPrimitive)?.takeIf { it.isString }?.content) {
        "card" -> {
            val entries: List<Pair<String, JsonElement>> = when (val set = c["set"]) {
                is JsonObject -> set.entries.map { it.key to it.value }
                is JsonArray -> set.mapIndexed { i, x -> i.toString() to x }
                else -> return false
            }
            for ((k, value) in entries) {
                if (k == "log" || k == "id" || k == "__proto__") continue
                val had = card.fields[k]
                if (had == null || stamp > had.stamp) card.fields[k] = FieldState(value, stamp)
            }
            return true
        }
        "log" -> {
            val e = c["entry"] as? JsonObject ?: return false
            val note = (e["note"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return false
            card.log.getOrPut(id) { LogItem(stamp, LogEntry(jsText(e["at"]), jsText(e["who"]), note)) }
            return true
        }
        else -> return false
    }
}

// A record as plain fields and its log, oldest first.
class MergedCard(val id: String, val fields: Map<String, JsonElement>, val log: List<LogEntry>) {
    fun text(k: String): String? = (fields[k] as? JsonPrimitive)?.takeIf { it.isString }?.content

    // As merge.ts's cards() makes it: id, log, then the fields sorted, with
    // JS putting any whole-number keys first.
    fun toJson(): JsonObject {
        val m = LinkedHashMap<String, JsonElement>()
        val keys = jsOrder(listOf("id", "log") + fields.keys.sorted())
        for (k in keys) m[k] = when (k) {
            "id" -> JsonPrimitive(id)
            "log" -> JsonArray(log.map { it.toJson() })
            else -> fields.getValue(k)
        }
        return JsonObject(m)
    }
}

private fun isIndexKey(k: String) = Regex("0|[1-9][0-9]{0,9}").matches(k) && k.toLong() < 4294967295L

private fun jsOrder(keys: List<String>): List<String> {
    val (ints, rest) = keys.partition(::isIndexKey)
    return ints.sortedBy { it.toLong() } + rest
}

// The records in a fixed order, so two replicas' JSON is equal exactly
// when their states are.
fun cards(state: BoardState): List<MergedCard> =
    state.cards.keys.sorted().map { id ->
        val c = state.cards.getValue(id)
        MergedCard(
            id,
            c.fields.keys.sorted().associateWith { c.fields.getValue(it).value },
            c.log.values.sortedBy { it.stamp }.map { it.entry },
        )
    }

fun cardsJson(state: BoardState) = JsonArray(cards(state).map { it.toJson() })
