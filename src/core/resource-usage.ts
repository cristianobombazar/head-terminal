import { locale } from "../i18n";

const GIB = 1024 ** 3;

/** Amber once the machine is busy, red when it is nearly out of headroom. */
export function resourceLoadColor(percent: number): string {
  if (percent >= 85) {
    return "var(--status-error)";
  }
  if (percent >= 60) {
    return "var(--accent)";
  }
  return "var(--status-idle)";
}

export function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

/**
 * GiB in the app's language — "12,4" in Portuguese, "12.4" in English. The
 * decimal is dropped past 100 GiB, where a disk pair ("412/931 GB") would
 * otherwise not fit the sidebar; no thousands separator, for the same reason.
 */
function formatGib(bytes: number, decimals: number): string {
  return (bytes / GIB).toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false,
  });
}

/** "12,4/31,9 GB" — the sidebar is narrow, so no spaces around the slash. */
export function formatUsage(usedBytes: number, totalBytes: number): string {
  if (totalBytes <= 0) {
    return "—";
  }
  const decimals = totalBytes >= 100 * GIB ? 0 : 1;
  return `${formatGib(usedBytes, decimals)}/${formatGib(totalBytes, decimals)} GB`;
}
