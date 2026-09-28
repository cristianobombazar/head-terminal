import { afterEach, describe, expect, it, vi } from "vitest";

import { PALETTE_ACTIONS } from "../config/toolbar";
import { ACTIVITY_LABEL } from "../types/activity";
import { getLocale, msg, setLocale, subscribeLocale } from ".";

afterEach(() => {
  setLocale("pt-BR");
});

describe("setLocale", () => {
  it("switches every text and tells the subscribers once", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLocale(listener);

    expect(msg.sidebar.title).toBe("Sessões");
    setLocale("en");

    expect(getLocale()).toBe("en");
    expect(msg.sidebar.title).toBe("Sessions");
    expect(listener).toHaveBeenCalledTimes(1);

    setLocale("en");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setLocale("pt-BR");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps label tables built at import time in step", () => {
    const settings = PALETTE_ACTIONS.find((action) => action.id === "settings");
    const before = [ACTIVITY_LABEL.working, settings?.label];

    setLocale("en");

    expect([ACTIVITY_LABEL.working, settings?.label]).not.toEqual(before);
    expect(ACTIVITY_LABEL.working).toBe(msg.core.activity.working);
    expect(settings?.label).toBe(msg.core.toolbar.settings);
  });
});
