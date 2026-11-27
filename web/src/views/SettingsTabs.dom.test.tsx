// The strip at the head of the Settings tab's pages: which is shown, and
// what a click on the other asks of corkboard.settings.
import "@/testing/dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, click, fakeNvim, one, render } from "@/testing/render";
import { SettingsTabs } from "./SettingsTabs";

afterEach(cleanup);

describe("SettingsTabs", () => {
  test.each([
    ["settings", "Settings", "Brains", "brains"],
    ["brains", "Brains", "Settings", "settings"],
  ] as const)("on %s: it is the one selected, and a click on the other opens it", (on, mine, other, opens) => {
    const { nvim, take } = fakeNvim();
    const { el } = render(<SettingsTabs on={on} nvim={nvim} />);
    expect([...el.querySelectorAll("[role=tab]")].map((t) => [t.textContent, t.getAttribute("aria-selected")])).toEqual(
      on === "settings" ? [["Settings", "true"], ["Brains", "false"]] : [["Settings", "false"], ["Brains", "true"]],
    );
    click(one(el, "button", mine));
    expect(take()).toEqual([]);
    click(one(el, "button", other));
    expect(take()).toEqual([["settings.open", opens]]);
  });
});
