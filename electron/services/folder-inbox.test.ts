import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FolderInbox, resolveOpenedFolder } from "./folder-inbox";

describe("resolveOpenedFolder", () => {
  let root = "";

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "head-terminal-folder-"));
    await writeFile(path.join(root, "notes.md"), "");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("opens a folder as itself", async () => {
    expect(await resolveOpenedFolder(root)).toBe(root);
    expect(await resolveOpenedFolder(`${root}${path.sep}`)).toBe(`${root}${path.sep}`);
  });

  it("opens a file in the folder it sits in", async () => {
    expect(await resolveOpenedFolder(path.join(root, "notes.md"))).toBe(root);
  });

  it("drops what cannot be opened", async () => {
    expect(await resolveOpenedFolder(path.join(root, "missing"))).toBeNull();
    expect(await resolveOpenedFolder("relative/folder")).toBeNull();
    expect(await resolveOpenedFolder(`${root}\0x`)).toBeNull();
    expect(await resolveOpenedFolder(undefined)).toBeNull();
  });
});

describe("FolderInbox", () => {
  it("keeps the latest folder until the renderer asks for it", () => {
    const inbox = new FolderInbox();
    expect(inbox.receive("/a")).toBe(false);
    expect(inbox.receive("/b")).toBe(false);

    const deliver = vi.fn();
    expect(inbox.attach(deliver)).toBe("/b");
    expect(inbox.attach(deliver)).toBeNull();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("hands folders straight to a renderer that listens, and keeps them again once it is gone", () => {
    const inbox = new FolderInbox();
    const deliver = vi.fn();
    inbox.attach(deliver);

    expect(inbox.receive("/c")).toBe(true);
    expect(deliver).toHaveBeenCalledWith("/c");

    inbox.detach();
    expect(inbox.receive("/d")).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(inbox.attach(vi.fn())).toBe("/d");
  });
});
