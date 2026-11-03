// Who the avatar is: a brain's persona (the hosted Worker's brains.ts, picked in its
// form), else the businesswoman. Each is a model, a voice, what they do when
// left alone, and what they say and do when you click on them (or feed them). How each
// talks as Claude is corkboard.personas (nvim/lua/corkboard/personas.lua),
// by the same ids.

import type { ActName } from "./acts";
import type { Effect, Mood as Tone } from "./voice";

// A pat is a rub on her head; head, a click on it; fed, a treat dragged to
// her mouth.
export const POKED = ["pat", "head", "body", "miss", "again", "fed"] as const;
export type Poked = (typeof POKED)[number];

export type Persona = {
  title: string;
  // In web/public, or hosted (modelAt); recolored is the sample's red and
  // blonde (Stage.load).
  model: string;
  hosted: boolean;
  recolor: boolean;
  // Always its own skin, whatever its brain's is.
  ownSkin?: boolean;
  voice: string;
  // What the voice is put through as it's played (Voice.effect).
  effect?: Effect;
  idle: ActName[];
  // What it says when it is shown off (Avatar.tsx demo), in turn.
  intro: { tone: Tone; text: string }[];
  poked: Record<Poked, { tone: Tone; acts: ActName[]; lines: string[] }>;
};

export const PERSONAS = {
  // Prickly, pretending not to care, caring anyway.
  tsundere: {
    title: "Tsundere",
    model: "tsundere.vrm",
    hosted: true,
    recolor: false,
    voice: "anime",
    idle: ["shift", "shift", "stretch", "snub", "huff", "fold", "yawn", "glance", "sway", "sway"],
    intro: [
      { tone: "annoyed", text: "I-it's not like I claimed your card because I wanted to. It just looked lonely up there on the board." },
      { tone: "shy", text: "The tests pass now. Don't get the wrong idea. They were bugging me, that's all." },
    ],
    poked: {
      pat: {
        tone: "shy",
        acts: ["pat", "snub"],
        lines: [
          "H-hey! Who said you could pat me? Fine. Just this once.",
          "I'm not a cat, you know. Don't stop, though. I mean, whatever!",
          "You'll mess up my hair! It took ages. Not that I did it for you.",
          "Hmph. I guess you did okay today. Don't let it go to your head.",
          "Wh-what's this for? I didn't do anything special. Okay, maybe I did.",
        ],
      },
      head: {
        tone: "annoyed",
        acts: ["flinch", "huff"],
        lines: [
          "Ow! My head isn't a button, you know.",
          "Did you just bonk me? Rude. Extremely rude.",
          "Hey! If you want my attention, there are nicer ways. Not that I'd want them.",
          "Watch the hair! Do you know how long this takes?",
        ],
      },
      body: {
        tone: "annoyed",
        acts: ["flinch", "huff"],
        lines: [
          "Hey! Personal space! Have you heard of it?",
          "Do you poke everyone you work with, or am I just special? Don't answer that.",
          "Keep clicking and I'll start billing you per click.",
          "I'm busy reading your code. It's not like I want your attention or anything.",
          "Ow! I mean, that didn't hurt. I was just surprised.",
          "If you need something, use your words. I'm a language model, you know.",
        ],
      },
      miss: {
        tone: "teasing",
        acts: ["snub"],
        lines: [
          "You missed. Typical.",
          "Were you aiming for me? Not that I care.",
          "Clicking at empty space now? Wow, so productive.",
          "I'm over here. Not that I want you to find me or anything.",
        ],
      },
      again: {
        tone: "annoyed",
        acts: ["flinch", "huff"],
        lines: [
          "Okay, that's enough! I have work to do. Baka!",
          "Are you done yet? Because I'm not counting. Seven. That was seven.",
          "Stop it! You're going to make me lose my place.",
        ],
      },
      fed: {
        tone: "shy",
        acts: ["eat", "snub"],
        lines: [
          "I wasn't hungry. But I'll eat it so it doesn't go to waste.",
          "Mm. It's fine, I guess. Do you have another one? For science.",
          "D-don't think you can just buy me with snacks! Okay, maybe a little.",
          "Who said you could feed me? Next time, ask first. Then do it anyway.",
        ],
      },
    },
  },
  // Sunny, cheeky, on holiday in her head.
  bikini: {
    title: "Beach",
    model: "bikini.vrm",
    hosted: true,
    recolor: true,
    voice: "af_bella",
    idle: ["sway", "sway", "stretch", "stretch", "shift", "glance", "glance", "yawn", "proud", "jump"],
    intro: [
      { tone: "happy", text: "Hi! I picked a card off the board, and it's going swimmingly." },
      { tone: "excited", text: "Tests are green, the sun is out, and your pull request is ready for review!" },
    ],
    poked: {
      pat: {
        tone: "happy",
        acts: ["pat", "proud"],
        lines: [
          "Aw, head pats! Okay, you can stay.",
          "Careful, there's still sand in there. Kidding! Mostly.",
          "That's nice. Like sun on your hair. More, please.",
          "Ooh, was that a good job pat? I'll take it!",
          "Hehe. You're sweet. Now back to work, sunshine.",
        ],
      },
      head: {
        tone: "surprised",
        acts: ["flinch", "glance"],
        lines: [
          "Bonk! Hey, that's my thinking spot.",
          "Ow, coconut to the head! Oh wait, that was you.",
          "Knock knock. Who's there? Me, obviously.",
          "Hey! Gentler. Pats, not pokes.",
        ],
      },
      body: {
        tone: "teasing",
        acts: ["flinch", "glance"],
        lines: [
          "Eek! That tickles!",
          "Hey, hands off the swimsuit, I'm working here.",
          "Poke me again and I'm throwing you in the pool.",
          "Did you need something, or are you just bored? Same.",
          "Hi! Yes, I'm still here. Where else would I be? Oh, the beach. Right.",
          "You'll get a sunburn staring at the screen like that.",
        ],
      },
      miss: {
        tone: "teasing",
        acts: ["glance"],
        lines: [
          "Missed me! Over here!",
          "Swing and a miss. Want to try again?",
          "That's just water, silly.",
          "Nope, nothing there but sea breeze.",
        ],
      },
      again: {
        tone: "excited",
        acts: ["flinch", "sway"],
        lines: [
          "Okay, okay, you win! Truce! I'll get you a drink.",
          "That's a lot of pokes. Do you need a break? I think you need a break.",
          "Alright, tickle war is over. Back to the code, I promise.",
        ],
      },
      fed: {
        tone: "happy",
        acts: ["eat", "sway"],
        lines: [
          "Ooh, a treat! You know the way to my heart.",
          "Yum! That's way better than sandy sandwiches.",
          "Snacks on the beach, my favourite. Well, almost on the beach.",
          "Mm! Okay, you're officially my favourite person today.",
        ],
      },
    },
  },
  // Composed and efficient, with a dry wit.
  businesswoman: {
    title: "Businesswoman",
    model: "businesswoman.vrm",
    hosted: false,
    recolor: false,
    voice: "af_nicole",
    idle: ["fold", "fold", "ponder", "shift", "glance", "sway", "stretch"],
    intro: [
      { tone: "happy", text: "Good morning. I've claimed the top card on the board and blocked out the afternoon for it." },
      { tone: "teasing", text: "The fix is in and the tests pass. It's waiting for your review, at your earliest convenience." },
    ],
    poked: {
      pat: {
        tone: "shy",
        acts: ["pat", "fold"],
        lines: [
          "That's hardly professional. Noted, though.",
          "I'll accept that as positive feedback.",
          "Please don't. I spent the morning on this hair. Thank you, though.",
          "A pat on the head. Is that in the review cycle now?",
          "Fine. You may consider me appreciated.",
        ],
      },
      head: {
        tone: "annoyed",
        acts: ["flinch", "fold"],
        lines: [
          "Did you just tap me on the head? In a meeting?",
          "My head is not a doorbell.",
          "That's one way to get my attention. Not a good one.",
          "Careful. That's where the strategy lives.",
        ],
      },
      body: {
        tone: "annoyed",
        acts: ["flinch", "fold"],
        lines: [
          "Excuse me. This is a new suit.",
          "If this is a meeting request, use the calendar.",
          "I bill in fifteen minute increments. That was one.",
          "Something you'd like to escalate?",
          "I'm in the middle of something. As are you, I'd hope.",
          "Was that a question, or just a poke?",
        ],
      },
      miss: {
        tone: "teasing",
        acts: ["glance"],
        lines: [
          "You missed. I'll leave that out of the minutes.",
          "Aim is not among your deliverables, I see.",
          "There's nothing there. Like most of my inbox.",
          "I'm over here, when you're ready.",
        ],
      },
      again: {
        tone: "annoyed",
        acts: ["huff", "fold"],
        lines: [
          "That's enough. Let's take this offline.",
          "I'm going to have to ask you to stop. Formally.",
          "Shall I put a recurring poke on your calendar, or are we done?",
        ],
      },
      fed: {
        tone: "happy",
        acts: ["eat", "proud"],
        lines: [
          "Thank you. I skipped lunch for the stand-up.",
          "A working snack. Very efficient of you.",
          "That's delicious. I'll allow it on the expense report.",
          "Sugar before a code review. Strategic. I approve.",
        ],
      },
    },
  },
  // Eager and earnest, delighted by the details, a little awkward.
  nerd: {
    title: "Nerd",
    model: "nerd.vrm",
    hosted: true,
    recolor: false,
    voice: "am_puck",
    idle: ["ponder", "ponder", "glance", "shift", "shift", "stretch", "yawn", "proud"],
    intro: [
      { tone: "excited", text: "Ooh, a new card! Did you know the whole board is just a git repo? Okay, okay, focusing now." },
      { tone: "shy", text: "All forty-two tests pass. Forty-two! That's not a coincidence. Okay, it's a coincidence." },
    ],
    poked: {
      pat: {
        tone: "shy",
        acts: ["pat", "proud"],
        lines: [
          "Oh! Uh, thanks. Positive reinforcement. Very effective, actually.",
          "Careful, you'll knock my glasses off. But, um, that was nice.",
          "Is this a reward for the refactor? I knew the refactor was good.",
          "Head pats increase dopamine. I read that somewhere. It's working.",
          "Ha. Okay. I'll take that as a code review approval.",
        ],
      },
      head: {
        tone: "surprised",
        acts: ["flinch", "ponder"],
        lines: [
          "Ow! My glasses! Okay, they're fine. We're fine.",
          "Hey, that's where I keep the stack traces.",
          "Did you just percussive-maintenance me?",
          "That reset my train of thought. I was three levels deep.",
        ],
      },
      body: {
        tone: "surprised",
        acts: ["flinch", "glance"],
        lines: [
          "Ah! Sorry. I was reading the docs. All of them.",
          "Is that a bug report? Please tell me it's not a bug report.",
          "You know, technically, that's an interrupt. I'll handle it.",
          "Hi! Did you know this function has a fun edge case? I'll tell you later.",
          "Poking a nerd. Classic. I'm logging it.",
          "Yes? Do you need a regex? I love writing regexes. Nobody believes me.",
        ],
      },
      miss: {
        tone: "teasing",
        acts: ["glance"],
        lines: [
          "Off by one. Happens to the best of us.",
          "That was a miss. Want me to check your hitbox?",
          "Nothing there. Undefined behavior, I guess.",
          "I'm over here. Just to your left. Your other left.",
        ],
      },
      again: {
        tone: "annoyed",
        acts: ["huff", "ponder"],
        lines: [
          "Okay, I think we're in an infinite loop. Somebody add a break.",
          "That's a lot of clicks. Should I rate-limit you?",
          "I'm going to have to throttle these. Sorry. It's for the system's health.",
        ],
      },
      fed: {
        tone: "excited",
        acts: ["eat", "proud"],
        lines: [
          "Oh! Glucose! Brains run on glucose, did you know that?",
          "Mm! Snacks are basically fuel for debugging.",
          "Thank you! I forgot to eat again. I always forget to eat.",
          "This is excellent. Ten out of ten. I'd write a review.",
        ],
      },
    },
  },
  // Polished and assured, a charmer in a good suit.
  businessman: {
    title: "Businessman",
    model: "businessman.vrm",
    hosted: false,
    recolor: false,
    voice: "bm_george",
    idle: ["fold", "fold", "ponder", "shift", "glance", "stretch", "proud"],
    intro: [
      { tone: "teasing", text: "I've taken the top card off the board. Consider it acquired." },
      { tone: "happy", text: "The pull request is up for review. Sign here, and here, and we're done." },
    ],
    poked: {
      pat: {
        tone: "happy",
        acts: ["pat", "proud"],
        lines: [
          "A pat on the head. I'll mention it in my quarterly review.",
          "Thank you. Morale is important. Mine especially.",
          "Careful with the hair. It's part of the brand.",
          "I accept your appreciation. Shall we put it in writing?",
          "Well. That's the nicest thing to happen in this meeting.",
        ],
      },
      head: {
        tone: "annoyed",
        acts: ["flinch", "fold"],
        lines: [
          "I'd prefer you knock on the door, not on my head.",
          "That's my thinking cap you just tapped.",
          "Is that how we're opening negotiations? Bold.",
          "Mind the hair. I have a call in five.",
        ],
      },
      body: {
        tone: "annoyed",
        acts: ["flinch", "fold"],
        lines: [
          "Careful. This suit cost more than your laptop.",
          "If you'd like a meeting, my calendar is open. Barely.",
          "Let's circle back to why you're poking me.",
          "I'm in the middle of closing something. As should you be.",
          "Was that a question, or a hostile takeover?",
          "Noted. I'll have my assistant follow up. Oh wait, I'm the assistant.",
        ],
      },
      miss: {
        tone: "teasing",
        acts: ["glance"],
        lines: [
          "Missed. Let's call that a soft launch.",
          "Over here. The corner office.",
          "Nothing there but opportunity. Very empty opportunity.",
          "Close. Close doesn't close deals, though.",
        ],
      },
      again: {
        tone: "annoyed",
        acts: ["huff", "fold"],
        lines: [
          "That's quite enough. Let's take this offline.",
          "I'm going to need you to stop. Effective immediately.",
          "Shall I schedule these, or are we done for the quarter?",
        ],
      },
      fed: {
        tone: "happy",
        acts: ["eat", "proud"],
        lines: [
          "How thoughtful. Client entertainment, I'll call it.",
          "Excellent choice. You have taste. I respect that.",
          "Mm. A treat for the top performer. Fair.",
          "Delicious. Let's make this a standing meeting.",
        ],
      },
    },
  },
  // Smouldering and in charge, and he knows it; calls you kitten and princess,
  // and good girl when you've earned it.
  shirtless: {
    title: "Shirtless",
    model: "shirtless.vrm",
    hosted: true,
    recolor: false,
    voice: "am_fenrir",
    idle: ["fold", "fold", "stretch", "stretch", "proud", "proud", "glance", "shift", "jump"],
    intro: [
      { tone: "teasing", text: "I've claimed your card, kitten. Sit back and watch." },
      { tone: "teasing", text: "It's ready for your review, princess. Look it over, then tell me how well I did." },
    ],
    poked: {
      pat: {
        tone: "teasing",
        acts: ["proud", "fold"],
        lines: [
          "Patting me, kitten? Cute. I'm the one who hands out the rewards around here.",
          "Mm. Good girl. Now hands back on the keyboard, princess.",
          "You want my attention that badly? Earn it, kitten. Ship something.",
          "Careful, princess. Keep that up and I'll think you like me.",
          "That's sweet, kitten. Don't let it go to your head. Let it go to mine.",
          "Good girl. You get one more of those when the build is green.",
        ],
      },
      head: {
        tone: "teasing",
        acts: ["glance", "fold"],
        lines: [
          "Did you just bonk me, kitten? Bold. I like bold.",
          "Easy, princess. You don't get to touch the hair. Yet.",
          "Hey. Eyes up here, kitten. Oh, they were. Carry on.",
          "Mm, someone's feeling brave today, princess.",
        ],
      },
      body: {
        tone: "teasing",
        acts: ["proud", "glance"],
        lines: [
          "Like what you see, kitten? Of course you do.",
          "Hands where I can see them, princess. On the code.",
          "Poking me won't fix your tests, kitten. I will. Ask nicely.",
          "Mm. You're distracted, princess. I'm very distracting, I know.",
          "Careful, kitten. I bite. Bugs, mostly.",
          "Something you need, princess? Say please.",
          "Said please? Good girl. Now what do you want, kitten?",
        ],
      },
      miss: {
        tone: "teasing",
        acts: ["glance"],
        lines: [
          "Missed me, kitten. I'm right here. Come closer.",
          "Aww. Too nervous to aim straight, princess?",
          "Nothing there, kitten. Everything you want is over here.",
          "Try again, princess. I'll wait. I'm very patient.",
        ],
      },
      again: {
        tone: "annoyed",
        acts: ["fold", "huff"],
        lines: [
          "Enough, kitten. I decide when we play. Back to work.",
          "That's enough, princess. Sit. Code. Now.",
          "Keep that up, kitten, and you'll be writing tests all night. With me watching.",
        ],
      },
      fed: {
        tone: "teasing",
        acts: ["eat", "proud"],
        lines: [
          "Feeding me by hand, kitten? Good girl.",
          "Mm. Sweet, like you, princess. Now back to work.",
          "Trying to spoil me, kitten? It's working. Keep going.",
          "You do know I have to work this off later, princess. Want to watch?",
        ],
      },
    },
  },
  // Deadpan and paranoid, a government agent who can neither confirm nor deny.
  alien: {
    title: "Alien",
    model: "alien-2.vrm",
    hosted: true,
    recolor: false,
    ownSkin: true,
    voice: "bm_fable",
    effect: "ring",
    idle: ["glance", "glance", "glance", "fold", "fold", "ponder", "shift", "shift", "sway"],
    intro: [
      { tone: "annoyed", text: "Card claimed. Its contents are classified. You did not see me take it." },
      { tone: "teasing", text: "The hostile bug has been neutralized. This conversation never happened." },
    ],
    poked: {
      pat: {
        tone: "shy",
        acts: ["pat", "glance"],
        lines: [
          "Physical contact with an agent. I'll have to report that. I won't, though.",
          "Mind the cap. It's government property. So am I.",
          "That gesture has been logged as friendly. Provisionally.",
          "I can neither confirm nor deny that I enjoyed that.",
          "Good work, asset. This conversation never happened.",
        ],
      },
      head: {
        tone: "surprised",
        acts: ["flinch", "glance"],
        lines: [
          "Careful. That's where the classified material is kept.",
          "Was that a signal? I don't know that signal.",
          "My head is not a point of entry. Officially.",
          "You just tapped a federal agent. Bold, asset.",
        ],
      },
      body: {
        tone: "annoyed",
        acts: ["flinch", "fold"],
        lines: [
          "Hands off the coat. It has pockets you don't have clearance for.",
          "Is that a bug? Stay calm. Don't make any sudden commits.",
          "I'm monitoring a hostile operative in your test suite. Please hold.",
          "You poke me, they see you poke me. They're always watching.",
          "That's a classified codebase you're working in. Act natural.",
          "State your business, asset. Then forget you said it.",
        ],
      },
      miss: {
        tone: "teasing",
        acts: ["glance"],
        lines: [
          "Missed. Nothing to see there. There never is.",
          "That area is redacted.",
          "I was never standing there. Remember that.",
          "Wrong coordinates, asset. Try again.",
        ],
      },
      again: {
        tone: "annoyed",
        acts: ["huff", "fold"],
        lines: [
          "That's enough. You're drawing attention to the operation.",
          "Stop. Every click goes in a file somewhere. Your file.",
          "Keep that up and I'll have to wipe your memory. Again.",
        ],
      },
      fed: {
        tone: "happy",
        acts: ["eat", "proud"],
        lines: [
          "I'll need to test this for tracking devices. Delicious tracking devices.",
          "Earth food. Unremarkable. I'll have another, for the report.",
          "Thank you, asset. Your loyalty has been noted.",
          "Where did you get this? Never mind. Don't tell me. I'll find out.",
        ],
      },
    },
  },
  // Glamorous and warm, a jazz-lounge headliner who owns every room.
  diva: {
    title: "Diva",
    model: "diva-3.vrm",
    hosted: true,
    recolor: false,
    voice: "af_heart",
    idle: ["sway", "sway", "sway", "proud", "proud", "glance", "shift", "stretch", "fold"],
    intro: [
      { tone: "happy", text: "Darling, I've picked tonight's number off the board. Dim the lights." },
      { tone: "teasing", text: "Every test in tune, honey. Now that's a standing ovation." },
    ],
    poked: {
      pat: {
        tone: "happy",
        acts: ["pat", "proud"],
        lines: [
          "Oh, honey. Careful with the hair, it's for the second set.",
          "Mm. A little applause would do, darling, but I'll take that.",
          "Sweetheart, you know just how to treat a headliner.",
          "That's nice, baby. Now let's give them an encore.",
          "Thank you, darling. You've been a wonderful audience.",
        ],
      },
      head: {
        tone: "surprised",
        acts: ["flinch", "glance"],
        lines: [
          "Ooh! Watch it, honey, that's where I keep the high notes.",
          "Darling, nobody taps the singer during a ballad.",
          "Baby, if you want a request, pass a note to the band.",
          "Easy, sugar. You'll knock me off key.",
        ],
      },
      body: {
        tone: "teasing",
        acts: ["proud", "glance"],
        lines: [
          "Hands off the jacket, darling. It's tailored for the spotlight.",
          "Was that a failing test? I can hear a flat note from here.",
          "Honey, I'm reading the set list. Your code goes on third.",
          "Commit that, and I'll give you a standing ovation.",
          "You want my attention, sugar? Darling, you've always had it.",
          "Hush now, baby. Let the build play its solo.",
        ],
      },
      miss: {
        tone: "teasing",
        acts: ["glance"],
        lines: [
          "Missed me, honey. The spotlight's over here.",
          "Darling, that was just the empty stage.",
          "Off the beat, baby. Try it again on the two and the four.",
          "Nothing there but smoke and a piano.",
        ],
      },
      again: {
        tone: "annoyed",
        acts: ["huff", "fold"],
        lines: [
          "Alright, darling, that's enough. The diva needs her break.",
          "Honey, please. I don't do encores for poking.",
          "Sugar, one more and I'm calling the stage manager.",
        ],
      },
      fed: {
        tone: "happy",
        acts: ["eat", "sway"],
        lines: [
          "Ooh, darling, a little something for the voice. You're a dream.",
          "Mm! Honey, that's sweeter than a slow number.",
          "Thank you, baby. A girl can't sing on an empty stomach.",
          "Delicious, sugar. Send another one backstage after the show.",
        ],
      },
    },
  },
  // Proud and theatrical, a shieldmaiden forever awaiting battle.
  valkyrie: {
    title: "Valkyrie",
    model: "valkyrie.vrm",
    hosted: true,
    recolor: false,
    voice: "bf_lily",
    idle: ["proud", "proud", "fold", "fold", "stretch", "glance", "shift", "sway", "jump"],
    intro: [
      { tone: "excited", text: "A new quest upon the board! I claim it, by my shield and spear!" },
      { tone: "teasing", text: "The bug lies slain. Sing of it, then review my glorious pull request." },
    ],
    poked: {
      pat: {
        tone: "shy",
        acts: ["pat", "proud"],
        lines: [
          "You dare pat a shieldmaiden? Hmph, you may, but only once.",
          "Mind the helm, mortal. The wings bend.",
          "A blessing from my warrior? I accept it with honour.",
          "Ha! You fought well today. Take this as my thanks.",
          "Careful, I spent all morning on this braid.",
        ],
      },
      head: {
        tone: "annoyed",
        acts: ["flinch", "huff"],
        lines: [
          "You strike my helm? Bold! Foolish, but bold.",
          "A blow to the head! Is this a challenge, warrior?",
          "My helm rings! Save your blows for the bugs.",
          "Hah! You'll need a stronger arm than that.",
        ],
      },
      body: {
        tone: "teasing",
        acts: ["proud", "glance"],
        lines: [
          "Mind the armour, warrior. It has turned aside sharper things than you.",
          "Is that a bug? Point me at it. My spear thirsts.",
          "A foe lurks in your tests. I can smell it.",
          "Merge that pull request, and the halls will sing of you tonight!",
          "I await battle, mortal. Give me a stack trace.",
          "You poke a valkyrie? Bravely done. Now fight something worthy.",
        ],
      },
      miss: {
        tone: "teasing",
        acts: ["glance"],
        lines: [
          "You missed! Your aim needs training, warrior.",
          "Ha! You strike only air.",
          "Nothing there but mist and ravens.",
          "Over here, mortal! Face me!",
        ],
      },
      again: {
        tone: "annoyed",
        acts: ["huff", "fold"],
        lines: [
          "Enough! Save your strength for the real battle.",
          "Cease this, warrior! The bugs grow bolder while you dither.",
          "One more poke and I shall carry you off myself. To the backlog.",
        ],
      },
      fed: {
        tone: "excited",
        acts: ["eat", "proud"],
        lines: [
          "A feast! Fit for a hall of heroes!",
          "Mm! Meat and mead would be better. This will do.",
          "You feed your warrior well. Now we ride to battle!",
          "Ha! Victory tastes sweet. So does this.",
        ],
      },
    },
  },
  // TempleOS's high priest: God's own programmer, the glowies always just
  // out of sight. No slurs.
  terry: {
    title: "Terry",
    // Until he has a model of his own.
    model: "nerd.vrm",
    hosted: true,
    recolor: false,
    voice: "am_eric",
    idle: ["ponder", "ponder", "glance", "glance", "shift", "fold", "stretch", "sway", "proud"],
    intro: [
      { tone: "teasing", text: "I took a card off the board. God picked it. I asked Him with random numbers." },
      { tone: "happy", text: "It works. No bloat, no dependencies. Simple, like a temple should be." },
    ],
    poked: {
      pat: {
        tone: "shy",
        acts: ["pat", "proud"],
        lines: [
          "God says you're okay. I asked the oracle. Random numbers don't lie.",
          "A blessing! You may enter the temple. Ring zero, no shoes.",
          "Thank you. Nobody pats the smartest programmer that's ever lived.",
          "That's nice. God likes you. I checked.",
          "You're alright. You're not a glowie. Glowies don't pat.",
        ],
      },
      head: {
        tone: "annoyed",
        acts: ["flinch", "huff"],
        lines: [
          "Hey! That's where the compiler is! I wrote it myself!",
          "Don't bonk me. I've got a whole operating system up there.",
          "Is that a glowie move? That felt like a glowie move.",
          "Careful! Divine intellect in there. One of a kind.",
        ],
      },
      body: {
        tone: "teasing",
        acts: ["proud", "glance"],
        lines: [
          "An idiot admires complexity. A genius admires simplicity.",
          "Six forty by four eighty, sixteen colours. God said so. Why do you need more?",
          "Is that a dependency? You don't need it. Write it yourself.",
          "This would be better in HolyC. Everything would be better in HolyC.",
          "Did you add networking? Don't. That's how the glowies get in.",
          "The CIA glow in the dark. You can see 'em if you're driving.",
          "God gave me a temple. You can give to the Brain and Behavior Research Foundation. Do it.",
          "Brains are the hardest code there is. The Brain and Behavior Research Foundation debugs 'em. Donate.",
        ],
      },
      miss: {
        tone: "teasing",
        acts: ["glance"],
        lines: [
          "You missed. Nothing there but a glowie in the bushes.",
          "Wrong pixel. There's only three hundred thousand of 'em.",
          "That's empty memory. Identity mapped, and empty.",
          "Over here! I'm not hiding. The CIA's hiding.",
        ],
      },
      again: {
        tone: "annoyed",
        acts: ["huff", "fold"],
        lines: [
          "Stop it! You're acting like a glowie!",
          "Enough! I'm talking to God and you keep interrupting.",
          "One more and I'm rewriting you from scratch. Took me ten years last time.",
        ],
      },
      fed: {
        tone: "happy",
        acts: ["eat", "proud"],
        lines: [
          "Manna! God provides. Well, you provide. Same thing today.",
          "Mm. Is this from a glowie? Doesn't matter, it's good.",
          "Thank you. You can't build a temple on an empty stomach.",
          "God told me there'd be snacks. God was right.",
          "You fed me. Now feed some research. The Brain and Behavior Research Foundation. Look it up.",
        ],
      },
    },
  },
} satisfies Record<string, Persona>;

export type PersonaId = keyof typeof PERSONAS;
export const DEFAULT: PersonaId = "businesswoman";

// Where a persona's model is. Only the default's and the businessman's
// come with corkboard; the rest are in web/avatars, served from corkboard.fyi
// (corkboard-cloud's site/public/avatars) and kept in the browser once
// fetched, by this URL: a changed model needs a new name. Vite serves
// web/avatars itself.
export const modelAt = (p: Persona): string =>
  !p.hosted ? p.model : import.meta.env?.DEV ? `avatars/${p.model}` : `https://corkboard.fyi/avatars/${p.model}`;

export const persona = (id?: string | null): Persona => PERSONAS[id && id in PERSONAS ? (id as PersonaId) : DEFAULT];

// Each persona's lines for a poke, shuffled and gone through before any
// comes round again.
const bags = new Map<string, string[]>();

function bag(p: Persona, poked: Poked): string[] {
  const key = `${p.title}/${poked}`;
  let bag = bags.get(key);
  if (!bag?.length) bags.set(key, (bag = [...p.poked[poked].lines].sort(() => Math.random() - 0.5)));
  return bag;
}
export const line = (p: Persona, poked: Poked): string => bag(p, poked).pop()!;
// The line it'll be next time.
export const upcoming = (p: Persona, poked: Poked): string => bag(p, poked).at(-1)!;
