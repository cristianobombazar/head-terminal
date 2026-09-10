import { statfs } from "node:fs/promises";
import { cpus, freemem, homedir, totalmem } from "node:os";

import type { DiskUsage, ResourceUsage, UsageSample } from "../types/api";

/** Disk barely moves between reads, so it is not worth a syscall every poll. */
const DISK_TTL_MS = 10_000;

export interface CpuTimesSample {
  /** Idle jiffies summed over every core. */
  idle: number;
  /** Idle + busy jiffies summed over every core. */
  total: number;
}

interface CpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

export function sampleCpuTimes(
  cores: ReadonlyArray<{ times: CpuTimes }> = cpus(),
): CpuTimesSample {
  let idle = 0;
  let total = 0;
  for (const { times } of cores) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

/**
 * Busy share of the window between two cumulative samples, 0-100.
 *
 * A window with no elapsed CPU time — two reads in the same tick, or counters
 * that went backwards after a suspend — has nothing to report, and 0 is the
 * only honest answer that keeps the meter from spiking on resume.
 */
export function cpuPercentBetween(
  previous: CpuTimesSample,
  current: CpuTimesSample,
): number {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0 || idleDelta < 0) {
    return 0;
  }
  return clampPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

export function usageSample(usedBytes: number, totalBytes: number): UsageSample {
  const total = Math.max(0, totalBytes);
  const used = Math.min(total, Math.max(0, usedBytes));
  return {
    usedBytes: used,
    totalBytes: total,
    percent: total > 0 ? clampPercent((used / total) * 100) : 0,
  };
}

/** The volume a path lives on — `C:` on Windows, the path itself elsewhere. */
export function volumeLabel(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") {
    return path;
  }
  const drive = /^([a-z]):/iu.exec(path);
  return drive ? `${drive[1].toUpperCase()}:` : path;
}

export interface FilesystemStats {
  bsize: number;
  blocks: number;
  bavail: number;
}

/**
 * Free space is taken from `bavail` — what this user may actually write — so
 * a reserved root pool counts as used, the same way it is unavailable to us.
 */
export function diskUsageFrom(
  stats: FilesystemStats,
  label: string,
): DiskUsage {
  const blockSize = Number(stats.bsize);
  const total = Number(stats.blocks) * blockSize;
  const available = Number(stats.bavail) * blockSize;
  return { label, ...usageSample(total - available, total) };
}

/** null on an unreadable volume — a disconnected network drive, or no access. */
async function statfsDisk(path: string): Promise<DiskUsage | null> {
  try {
    return diskUsageFrom(await statfs(path), volumeLabel(path));
  } catch {
    return null;
  }
}

export interface ResourceUsageDeps {
  sampleCpu?: () => CpuTimesSample;
  readMemory?: () => { free: number; total: number };
  readDisk?: () => Promise<DiskUsage | null>;
  now?: () => number;
}

/**
 * Reader over the whole machine — not this process: the sidebar meter answers
 * "how loaded is my computer", so it uses the host counters `node:os` and
 * `statfs` expose on every platform instead of Electron's process metrics.
 *
 * CPU only exists as a delta, so each call reports the window since the
 * previous one. The first call has no window and falls back to the since-boot
 * average, which a zero baseline over cumulative counters gives for free.
 */
export function createResourceUsageReader({
  sampleCpu = () => sampleCpuTimes(),
  readMemory = () => ({ free: freemem(), total: totalmem() }),
  // The home volume: where the agent sessions, repos and caches actually land.
  readDisk = () => statfsDisk(homedir()),
  now = Date.now,
}: ResourceUsageDeps = {}): () => Promise<ResourceUsage> {
  let previous: CpuTimesSample = { idle: 0, total: 0 };
  // A failed read is cached too, so an unreachable volume is not retried on
  // every poll.
  let disk: { at: number; value: DiskUsage | null } | null = null;

  return async () => {
    const current = sampleCpu();
    const cpuPercent = cpuPercentBetween(previous, current);
    previous = current;

    const { free, total } = readMemory();

    if (!disk || now() - disk.at >= DISK_TTL_MS) {
      disk = { at: now(), value: await readDisk() };
    }

    return {
      cpuPercent,
      memory: usageSample(total - free, total),
      disk: disk.value,
    };
  };
}

export const getResourceUsage = createResourceUsageReader();
