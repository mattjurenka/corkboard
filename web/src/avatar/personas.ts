// Who the avatar is: a brain's persona (cloud/src/brains.ts, picked in its
// form), else the tsundere. Each is a model, a voice, what they do when
// left alone, and what they say and do when you click on them. How each
// talks as Claude is corkboard.personas (nvim/lua/corkboard/personas.lua),
// by the same ids.

import type { ActName } from "./acts";
import type { Mood as Tone } from "./voice";

// A pat is a rub on her head; head, a click on it.
export type Poked = "pat" | "head" | "body" | "miss" | "again";

export type Persona = {
  title: string;
  // In web/public; recolored is the sample's red and blonde (Stage.load).
  model: string;
  recolor: boolean;
  voice: string;
  idle: ActName[];
  poked: Record<Poked, { tone: Tone; acts: ActName[]; lines: string[] }>;
};

export const PERSONAS = {
  // Prickly, pretending not to care, caring anyway.
  tsundere: {
    title: "Tsundere",
    model: "tsundere.vrm",
    recolor: false,
    voice: "anime",
    idle: ["shift", "shift", "stretch", "snub", "huff", "fold", "yawn", "glance", "sway", "sway"],
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
    },
  },
  // Sunny, cheeky, on holiday in her head.
  bikini: {
    title: "Beach",
    model: "bikini.vrm",
    recolor: true,
    voice: "anime",
    idle: ["sway", "sway", "stretch", "stretch", "shift", "glance", "glance", "yawn", "proud"],
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
    },
  },
  // Composed and efficient, with a dry wit.
  businesswoman: {
    title: "Businesswoman",
    model: "businesswoman.vrm",
    recolor: true,
    voice: "anime",
    idle: ["fold", "fold", "ponder", "shift", "glance", "sway", "stretch"],
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
    },
  },
  // Eager and earnest, delighted by the details, a little awkward.
  nerd: {
    title: "Nerd",
    model: "nerd.vrm",
    recolor: false,
    voice: "am_puck",
    idle: ["ponder", "ponder", "glance", "shift", "shift", "stretch", "yawn", "proud"],
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
    },
  },
  // Polished and assured, a charmer in a good suit.
  businessman: {
    title: "Businessman",
    model: "businessman.vrm",
    recolor: false,
    voice: "bm_george",
    idle: ["fold", "fold", "ponder", "shift", "glance", "stretch", "proud"],
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
    },
  },
  // Easygoing and warm, all good vibes and no shirt.
  shirtless: {
    title: "Shirtless",
    model: "shirtless.vrm",
    recolor: false,
    voice: "am_fenrir",
    idle: ["stretch", "stretch", "sway", "sway", "shift", "yawn", "glance", "proud"],
    poked: {
      pat: {
        tone: "happy",
        acts: ["pat", "proud"],
        lines: [
          "Aw, thanks, friend. Good vibes received.",
          "Hey, easy on the hair. Took me all of zero minutes.",
          "That's nice. Keep that energy.",
          "A head pat? You're alright, you know that?",
          "Cool, cool. I'll pat you back when the build passes.",
        ],
      },
      head: {
        tone: "surprised",
        acts: ["flinch", "glance"],
        lines: [
          "Whoa! Bonk. Okay. I felt that one.",
          "Hey, gentle, my brain's in there. Most of it.",
          "Ow. No worries. I've had worse from surfboards.",
          "Knock knock. Yeah, I'm home.",
        ],
      },
      body: {
        tone: "teasing",
        acts: ["flinch", "glance"],
        lines: [
          "Hey! Ticklish. Totally ticklish.",
          "Yeah, I know, no shirt. It's a whole thing. Very aerodynamic.",
          "What's up? Need a hand? Or a spot?",
          "Poke all you want, these are real. The abs, I mean. And the code.",
          "Easy, buddy. We're all chill here.",
          "Did you need something, or just saying hi? Hi!",
        ],
      },
      miss: {
        tone: "teasing",
        acts: ["glance"],
        lines: [
          "Missed me. No stress.",
          "Whiff! That's okay, happens to everyone.",
          "Just air there, friend.",
          "Over here! Wave if you can see me.",
        ],
      },
      again: {
        tone: "annoyed",
        acts: ["huff", "sway"],
        lines: [
          "Alright, alright, you win. Let's both get back to it.",
          "That's a lot of pokes. Want to go take a walk? I think you need a walk.",
          "Okay, poke break's over. Code time.",
        ],
      },
    },
  },
} satisfies Record<string, Persona>;

export type PersonaId = keyof typeof PERSONAS;
export const DEFAULT: PersonaId = "tsundere";

export const persona = (id?: string | null): Persona => PERSONAS[id && id in PERSONAS ? (id as PersonaId) : DEFAULT];

// Each persona's lines for a poke, shuffled and gone through before any
// comes round again.
const bags = new Map<string, string[]>();

export function line(p: Persona, poked: Poked): string {
  const key = `${p.title}/${poked}`;
  let bag = bags.get(key);
  if (!bag?.length) bags.set(key, (bag = [...p.poked[poked].lines].sort(() => Math.random() - 0.5)));
  return bag.pop()!;
}
