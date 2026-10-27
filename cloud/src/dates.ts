// The days a question is about, worked out in code: models are unreliable at
// date arithmetic, so recall doesn't ask one to do it. "yesterday", "last
// Tuesday", "3 weeks ago", "last week", "Oct 24", "2026-10-24" become a
// range of days, from today where the user is (plans.ts's today, which
// turns over at 4am).

export type Range = { from: string; to: string; said: string };

const DAY_MS = 86_400_000;
const at = (day: string) => Date.parse(`${day}T12:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const add = (day: string, days: number) => iso(at(day) + days * DAY_MS);
// 0 is Monday.
const weekday = (day: string) => (new Date(at(day)).getUTCDay() + 6) % 7;

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const count = (w: string) => NUMBERS[w] ?? Number(w);

// The first date the question names, or null.
export function range(question: string, today: string): Range | null {
  const q = question.toLowerCase();
  let m: RegExpMatchArray | null;

  if ((m = q.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) return { from: m[0], to: m[0], said: m[0] };
  if ((m = q.match(/\btoday\b/))) return { from: today, to: today, said: m[0] };
  if ((m = q.match(/\byesterday\b/))) return { from: add(today, -1), to: add(today, -1), said: m[0] };
  if ((m = q.match(/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week|month)s?\s+ago\b/))) {
    const n = count(m[1]);
    if (m[2] === "day") return { from: add(today, -n), to: add(today, -n), said: m[0] };
    if (m[2] === "week") {
      const monday = add(add(today, -7 * n), -weekday(add(today, -7 * n)));
      return { from: monday, to: add(monday, 6), said: m[0] };
    }
    const [y, mo] = today.split("-").map(Number);
    const first = new Date(Date.UTC(y, mo - 1 - n, 1));
    return { from: iso(first.getTime()), to: iso(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)), said: m[0] };
  }
  if ((m = q.match(/\b(last|this)\s+week\b/))) {
    const monday = add(today, -weekday(today) - (m[1] === "last" ? 7 : 0));
    return { from: monday, to: m[1] === "last" ? add(monday, 6) : today, said: m[0] };
  }
  if ((m = q.match(/\b(last|this)\s+month\b/))) {
    const [y, mo] = today.split("-").map(Number);
    const first = new Date(Date.UTC(y, mo - 1 - (m[1] === "last" ? 1 : 0), 1));
    const last = m[1] === "last" ? iso(Date.UTC(y, mo - 1, 0)) : today;
    return { from: iso(first.getTime()), to: last, said: m[0] };
  }
  // "last tuesday", "on tuesday", "tuesday": the most recent one before
  // today ("last" one more week back only when that's still this week).
  if ((m = q.match(new RegExp(`\\b(last\\s+|on\\s+)?(${WEEKDAYS.join("|")})\\b`)))) {
    const want = WEEKDAYS.indexOf(m[2]);
    const back = (weekday(today) - want + 7) % 7 || 7;
    const day = add(today, -back);
    return { from: day, to: day, said: m[0].trim() };
  }
  // "oct 24", "october 24th", "24 oct": this year's, or last year's if
  // that's still to come.
  const month = `(${MONTHS.join("|")})[a-z]*\\.?`;
  if ((m = q.match(new RegExp(`\\b${month}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`))) || (m = q.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${month}`)))) {
    const [mon, d] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    const mo = MONTHS.indexOf(mon.slice(0, 3));
    const [y] = today.split("-").map(Number);
    let day = iso(Date.UTC(y, mo, Number(d)));
    if (day > today) day = iso(Date.UTC(y - 1, mo, Number(d)));
    return { from: day, to: day, said: m[0] };
  }
  return null;
}
