import { describe, expect, it } from "vitest";

import { formatPercent, formatUsage, resourceLoadColor } from "./resource-usage";

const GIB = 1024 ** 3;

describe("resource-usage", () => {
  it("formats a usage pair in GiB with a pt-BR comma", () => {
    expect(formatUsage(12.44 * GIB, 31.9 * GIB)).toBe("12,4/31,9 GB");
  });

  it("drops the decimal on disk-sized totals, which would not fit", () => {
    expect(formatUsage(432 * GIB, 464.8 * GIB)).toBe("432/465 GB");
  });

  it("has no reading to format when the total is unknown", () => {
    expect(formatUsage(0, 0)).toBe("—");
  });

  it("rounds percentages to whole numbers", () => {
    expect(formatPercent(23.4)).toBe("23%");
    expect(formatPercent(99.6)).toBe("100%");
  });

  it("escalates the meter color with the load", () => {
    expect(resourceLoadColor(12)).toBe("var(--status-idle)");
    expect(resourceLoadColor(60)).toBe("var(--accent)");
    expect(resourceLoadColor(85)).toBe("var(--status-error)");
  });
});
