// What the avatar says when you click on her. She's a tsundere: prickly,
// pretending not to care, caring anyway. Each set is shuffled and gone
// through before any line comes round again.

export type Poked = "head" | "body" | "miss" | "again";

const LINES: Record<Poked, string[]> = {
  head: [
    "H-hey! Who said you could pat me? Fine. Just this once.",
    "I'm not a cat, you know. Don't stop, though. I mean, whatever!",
    "You'll mess up my hair! It took ages. Not that I did it for you.",
    "Hmph. I guess you did okay today. Don't let it go to your head.",
    "Wh-what's this for? I didn't do anything special. Okay, maybe I did.",
  ],
  body: [
    "Hey! Personal space! Have you heard of it?",
    "Do you poke everyone you work with, or am I just special? Don't answer that.",
    "Keep clicking and I'll start billing you per click.",
    "I'm busy reading your code. It's not like I want your attention or anything.",
    "Ow! I mean, that didn't hurt. I was just surprised.",
    "If you need something, use your words. I'm a language model, you know.",
  ],
  miss: [
    "You missed. Typical.",
    "Were you aiming for me? Not that I care.",
    "Clicking at empty space now? Wow, so productive.",
    "I'm over here. Not that I want you to find me or anything.",
  ],
  again: [
    "Okay, that's enough! I have work to do. Baka!",
    "Are you done yet? Because I'm not counting. Seven. That was seven.",
    "Stop it! You're going to make me lose my place.",
  ],
};

const bags: Partial<Record<Poked, string[]>> = {};

export function line(poked: Poked): string {
  let bag = bags[poked];
  if (!bag?.length) {
    bag = bags[poked] = [...LINES[poked]].sort(() => Math.random() - 0.5);
  }
  return bag.pop()!;
}
