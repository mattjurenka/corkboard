package app.corkboard

import kotlinx.serialization.Serializable

// The Worker's day plan (cloud/src/plans.ts), as much of it as the phone
// shows. Times are minutes since midnight.

@Serializable
data class Block(
    val id: String,
    val start: Int,
    val stop: Int,
    val title: String,
    val kind: String,
    val desc: String? = null,
    val project: String? = null,
    val tag: String? = null,
    val card: String? = null,
    val board: String? = null,
    val pinned: Boolean? = null,
)

@Serializable
data class Reason(val text: String, val source: String? = null, val tone: String? = null)

@Serializable
data class Proposal(
    val from: Int = 0,
    val blocks: List<Block> = emptyList(),
    val reasons: List<Reason> = emptyList(),
    val why: Map<String, String> = emptyMap(),
    val made: String = "",
    val by: String = "",
)

@Serializable
data class Day(val blocks: List<Block> = emptyList())

@Serializable
data class Plan(
    val date: String,
    val version: Int,
    val day: Day = Day(),
    val proposal: Proposal? = null,
    val asked: List<String> = emptyList(),
    val accepted: String? = null,
)

// A message between the user and Pepper (cloud/src/user.ts's chat).
@Serializable
data class ChatMessage(val id: Long, val at: String, val who: String, val text: String)

@Serializable
data class Auth(val clientId: String, val access: String, val refresh: String, val expiresAt: Long)

// A sign-in waiting for the browser to come back (Cloud.startSignIn).
@Serializable
data class PendingSignIn(val clientId: String, val verifier: String, val state: String)

fun clock(m: Int) = "%02d:%02d".format(m / 60 % 24, m % 60)

fun length(m: Int): String {
    val h = m / 60
    val rest = m % 60
    return when {
        h == 0 -> "${rest}m"
        rest == 0 -> "${h}h"
        else -> "%dh%02d".format(h, rest)
    }
}
