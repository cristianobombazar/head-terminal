import { describe, expect, it } from "vitest";

import {
  cpuPercentBetween,
  createResourceUsageReader,
  diskUsageFrom,
  sampleCpuTimes,
  volumeLabel,
} from "./resource-usage-service";

function core(times: Partial<{
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}>) {
  return {
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, ...times },
  };
}

const NO_MEMORY = () => ({ free: 0, total: 0 });
const NO_DISK = async () => null;

describe("resource-usage-service", () => {
  it("sums idle and total jiffies across every core", () => {
    expect(
      sampleCpuTimes([
        core({ user: 100, sys: 50, idle: 850 }),
        core({ user: 200, irq: 10, idle: 790 }),
      ]),
    ).toEqual({ idle: 1_640, total: 2_000 });
  });

  it("reports the busy share of the window between two samples", () => {
    expect(
      cpuPercentBetween({ idle: 1_000, total: 2_000 }, { idle: 1_300, total: 2_400 }),
    ).toBe(25);
  });

  it("reports zero when no CPU time elapsed or counters went backwards", () => {
    const sample = { idle: 1_000, total: 2_000 };
    expect(cpuPercentBetween(sample, sample)).toBe(0);
    expect(cpuPercentBetween(sample, { idle: 500, total: 1_000 })).toBe(0);
    // Suspend/resume can move idle back while total moves forward.
    expect(cpuPercentBetween(sample, { idle: 900, total: 2_400 })).toBe(0);
  });

  it("falls back to the since-boot average on the first read", async () => {
    const read = createResourceUsageReader({
      sampleCpu: () => ({ idle: 700, total: 1_000 }),
      readMemory: NO_MEMORY,
      readDisk: NO_DISK,
    });
    await expect(read().then((usage) => usage.cpuPercent)).resolves.toBe(30);
  });

  it("compares each read against the previous one", async () => {
    const samples = [
      { idle: 700, total: 1_000 },
      { idle: 900, total: 2_000 }, // 800 busy of 1000
      { idle: 1_800, total: 3_000 }, // 100 busy of 1000
    ];
    let index = 0;
    const read = createResourceUsageReader({
      sampleCpu: () => samples[index++],
      readMemory: NO_MEMORY,
      readDisk: NO_DISK,
    });

    await read();
    expect((await read()).cpuPercent).toBe(80);
    expect((await read()).cpuPercent).toBe(10);
  });

  it("derives used memory from free/total", async () => {
    const read = createResourceUsageReader({
      sampleCpu: () => ({ idle: 0, total: 0 }),
      readMemory: () => ({ free: 4_000, total: 16_000 }),
      readDisk: NO_DISK,
    });
    await expect(read().then((usage) => usage.memory)).resolves.toEqual({
      usedBytes: 12_000,
      totalBytes: 16_000,
      percent: 75,
    });
  });

  it("never divides by a zero total", async () => {
    const read = createResourceUsageReader({
      sampleCpu: () => ({ idle: 0, total: 0 }),
      readMemory: NO_MEMORY,
      readDisk: NO_DISK,
    });
    await expect(read().then((usage) => usage.memory)).resolves.toEqual({
      usedBytes: 0,
      totalBytes: 0,
      percent: 0,
    });
  });

  it("counts space this user cannot write as used disk", () => {
    // 400 blocks of 1000 bytes, 100 available: a reserved root pool inside
    // bfree still is not ours, so it lands on the used side.
    expect(diskUsageFrom({ bsize: 1_000, blocks: 400, bavail: 100 }, "C:")).toEqual({
      label: "C:",
      usedBytes: 300_000,
      totalBytes: 400_000,
      percent: 75,
    });
  });

  it("labels the volume by drive letter on Windows and by path elsewhere", () => {
    expect(volumeLabel("c:\Users\mathe", "win32")).toBe("C:");
    expect(volumeLabel("\\server\share", "win32")).toBe("\\server\share");
    expect(volumeLabel("/home/mathe", "linux")).toBe("/home/mathe");
  });

  it("keeps serving a null disk without re-reading the volume every poll", async () => {
    let reads = 0;
    let clock = 0;
    const read = createResourceUsageReader({
      sampleCpu: () => ({ idle: 0, total: 0 }),
      readMemory: NO_MEMORY,
      readDisk: async () => {
        reads += 1;
        return null;
      },
      now: () => clock,
    });

    await read();
    await read();
    expect(reads).toBe(1);

    clock = 10_000;
    await read();
    expect(reads).toBe(2);
  });

  it("caches the disk reading between polls", async () => {
    let reads = 0;
    let clock = 0;
    const disk = { label: "C:", usedBytes: 300, totalBytes: 400, percent: 75 };
    const read = createResourceUsageReader({
      sampleCpu: () => ({ idle: 0, total: 0 }),
      readMemory: NO_MEMORY,
      readDisk: async () => {
        reads += 1;
        return disk;
      },
      now: () => clock,
    });

    expect((await read()).disk).toEqual(disk);
    clock = 2_000;
    expect((await read()).disk).toEqual(disk);
    expect(reads).toBe(1);
  });
});
