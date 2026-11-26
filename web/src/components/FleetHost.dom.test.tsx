// Adding a fleet host (corkboard.fleet_host) as the store opens it: what the
// host printed pasted or typed, a passphrase where the root's under one, and
// the command to run there, copied by c or a click.
import "@/testing/dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { NvimContext } from "@/nvim/context";
import { store } from "@/store";
import { cleanup, click, fakeNvim, press, render, settle, type } from "@/testing/render";
import { FleetHost } from "./FleetHost";

afterEach(() => {
  cleanup();
  act(() => store.set({ fleetHost: null }));
});

type Host = NonNullable<ReturnType<typeof store.get>["fleetHost"]>;
const show = (h: Host) => act(() => store.set({ fleetHost: h }));

function open(h: Host) {
  const n = fakeNvim();
  const r = render(
    <NvimContext.Provider value={n.nvim}>
      <FleetHost />
    </NvimContext.Provider>,
  );
  show(h);
  return { ...n, ...r, dialog: () => r.el.querySelector<HTMLElement>("[role=dialog]")! };
}

const ID = "A".repeat(43);
const BOX = "B".repeat(43);

describe("FleetHost", () => {
  test("nothing until it's opened", () => {
    const { el } = render(
      <NvimContext.Provider value={fakeNvim().nvim}>
        <FleetHost />
      </NvimContext.Provider>,
    );
    expect(el.innerHTML).toBe("");
  });

  test("what's typed goes on Enter, not while there's nothing; an error shows over what was typed", () => {
    const { dialog, take } = open({ step: "paste" });
    const field = dialog().querySelector("textarea")!;
    expect(document.activeElement).toBe(field);
    press(field, "Enter");
    expect(take()).toEqual([]);
    type(field, `${ID} ${BOX}`);
    expect(press(field, "Enter").defaultPrevented).toBe(true);
    expect(take()).toEqual([["fleet_host.paste", `${ID} ${BOX}`]]);
    show({ step: "waiting" });
    expect(dialog().textContent).toContain("signing it in");
    show({ step: "paste", error: "that has no device in it" });
    expect(dialog().textContent).toContain("that has no device in it");
    expect(dialog().querySelector("textarea")!.value).toBe(`${ID} ${BOX}`);
  });

  test("a root under a passphrase is asked for it first, and again with what went wrong", () => {
    const { dialog, take } = open({ step: "paste", passphrase: true });
    const field = dialog().querySelector<HTMLInputElement>("input[type=password]")!;
    expect(document.activeElement).toBe(field);
    expect(dialog().querySelector("textarea")).toBeNull();
    type(field, "correct horse");
    act(() => void dialog().querySelector("form")!.requestSubmit());
    expect(take()).toEqual([["fleet_host.passphrase", "correct horse"]]);
    show({ step: "paste", passphrase: true, error: "wrong passphrase" });
    expect(dialog().textContent).toContain("wrong passphrase");
  });

  test("the command to run on the host, copied by a click; Enter closes, and Esc cancels", async () => {
    const { dialog, take, calls } = open({ step: "cert", name: "fleetd", device: ID, command: "corkboard-fleet device cert <<'EOF'\n{}\nEOF" });
    expect(dialog().querySelector("pre")!.textContent).toBe("corkboard-fleet device cert <<'EOF'\n{}\nEOF");
    expect(dialog().textContent).toContain("fleetd is certified");
    click(dialog().querySelector("pre")!);
    await settle();
    expect(await navigator.clipboard.readText()).toBe("corkboard-fleet device cert <<'EOF'\n{}\nEOF");
    expect(dialog().textContent).toContain("copied");
    press(dialog(), "Enter");
    expect(take()).toEqual([["fleet_host.cancel"]]);
    expect(store.get().fleetHost).toBeNull();
    expect(calls.refocus).toBe(1);
    show({ step: "paste" });
    press(dialog(), "Escape");
    expect(take()).toEqual([["fleet_host.cancel"]]);
    expect(store.get().fleetHost).toBeNull();
  });
});
