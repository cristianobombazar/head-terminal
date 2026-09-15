import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSessionWorktree,
  getWorktreeStatus,
  hasWorkInProgress,
  listWorktrees,
  planSessionWorktree,
  removeSessionWorktree,
  resolveRepoIdentity,
  samePath,
} from "./git-worktree-service";

const cleanup: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string): void {
  git(cwd, "commit", "--allow-empty", "-q", "-m", message);
}

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ht-wt-"));
  cleanup.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  commit(repo, "initial");
  // O caminho como o git o escreve, que é o que o serviço devolve: barra
  // normal no Windows, e o alvo resolvido de qualquer symlink.
  return git(repo, "rev-parse", "--show-toplevel");
}

afterEach(async () => {
  await Promise.all(
    // maxRetries: no Windows o git ainda pode estar soltando handles do repo
    // quando o afterEach chega, e o rm falha com EBUSY.
    cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    ),
  );
});

describe("git-worktree-service", () => {
  it("creates collision-free numbered sibling worktrees", async () => {
    const repo = await createRepo();

    const first = await createSessionWorktree(repo);
    const second = await createSessionWorktree(repo);

    expect(first.path).toBe(`${repo}-agent-1`);
    expect(first.branch).toBe("agent-1");
    expect(first.mainRepoRoot).toBe(repo);
    expect(second.path).toBe(`${repo}-agent-2`);
    expect(git(first.path, "branch", "--show-current")).toBe("agent-1");
    expect(git(second.path, "branch", "--show-current")).toBe("agent-2");
  });

  it("branches off the main repository even from inside a worktree", async () => {
    const repo = await createRepo();
    const first = await createSessionWorktree(repo);

    // Sem isso o segundo viraria `<repo>-agent-1-agent-2`, aninhado no primeiro.
    const second = await createSessionWorktree(first.path);

    expect(second.path).toBe(`${repo}-agent-2`);
    expect(second.mainRepoRoot).toBe(repo);
  });

  it("carries ignored config files over, skipping ignored directories", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, ".gitignore"), ".env\nnode_modules/\n");
    git(repo, "add", ".gitignore");
    commit(repo, "ignore rules");
    await writeFile(join(repo, ".env"), "TOKEN=secret\n");
    await mkdir(join(repo, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(repo, "node_modules", "left-pad", "index.js"), "//\n");

    const worktree = await createSessionWorktree(repo);

    expect(worktree.copiedFiles).toBe(1);
    await expect(readFile(join(worktree.path, ".env"), "utf8")).resolves.toBe(
      "TOKEN=secret\n",
    );
    await expect(
      readFile(join(worktree.path, "node_modules", "left-pad", "index.js")),
    ).rejects.toThrow();
  });

  it("leaves ignored files behind when asked not to copy", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, ".gitignore"), ".env\n");
    git(repo, "add", ".gitignore");
    commit(repo, "ignore rules");
    await writeFile(join(repo, ".env"), "TOKEN=secret\n");

    const worktree = await createSessionWorktree(repo, { copyIgnored: false });

    expect(worktree.copiedFiles).toBe(0);
    await expect(readFile(join(worktree.path, ".env"))).rejects.toThrow();
  });

  it("recommends a worktree only once the tree is occupied", async () => {
    const repo = await createRepo();

    const free = await planSessionWorktree({ cwd: repo, occupiedCwds: [] });
    expect(free).toMatchObject({ isRepo: true, occupants: 0, recommended: false });
    expect(free.mainRepoRoot).toBe(repo);

    const taken = await planSessionWorktree({ cwd: repo, occupiedCwds: [repo] });
    expect(taken).toMatchObject({ occupants: 1, recommended: true });
  });

  it("counts one occupant per terminal, not per distinct folder", async () => {
    const repo = await createRepo();

    const plan = await planSessionWorktree({
      cwd: repo,
      occupiedCwds: [repo, repo, repo],
    });

    expect(plan.occupants).toBe(3);
  });

  it("counts a subdirectory as the same tree and a worktree as another", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "src"));
    const worktree = await createSessionWorktree(repo);

    // Um terminal aberto em `repo/src` está na mesma árvore que `repo`.
    const fromSubdir = await planSessionWorktree({
      cwd: repo,
      occupiedCwds: [join(repo, "src")],
    });
    expect(fromSubdir.recommended).toBe(true);

    // Uma sessão já isolada em worktree não ocupa a árvore principal.
    const fromWorktree = await planSessionWorktree({
      cwd: repo,
      occupiedCwds: [worktree.path],
    });
    expect(fromWorktree.recommended).toBe(false);
  });

  it("ignores folders that are not repositories", async () => {
    const plain = await mkdtemp(join(tmpdir(), "ht-wt-plain-"));
    cleanup.push(plain);

    const plan = await planSessionWorktree({ cwd: plain, occupiedCwds: [plain] });

    expect(plan).toMatchObject({ isRepo: false, recommended: false });
    expect(await resolveRepoIdentity(plain)).toBeNull();
  });

  it("holds a worktree back while it has work nobody else has", async () => {
    const repo = await createRepo();
    const worktree = await createSessionWorktree(repo);

    const clean = await getWorktreeStatus(worktree.path);
    expect(clean).toMatchObject({
      exists: true,
      branch: "agent-1",
      isDirty: false,
      unpushedCommits: 0,
      safeToRemove: true,
    });

    await writeFile(join(worktree.path, "scratch.txt"), "wip\n");
    expect((await getWorktreeStatus(worktree.path)).safeToRemove).toBe(false);

    git(worktree.path, "add", "scratch.txt");
    commit(worktree.path, "wip");
    const committed = await getWorktreeStatus(worktree.path);
    expect(committed.isDirty).toBe(false);
    expect(committed.unpushedCommits).toBe(1);
    expect(committed.safeToRemove).toBe(false);
  });

  it("lists worktrees with the main repository first", async () => {
    const repo = await createRepo();
    const worktree = await createSessionWorktree(repo);

    const entries = await listWorktrees(worktree.path);

    expect(entries[0]).toMatchObject({ path: repo, isMain: true });
    expect(entries).toContainEqual(
      expect.objectContaining({ path: worktree.path, branch: "agent-1", isMain: false }),
    );
  });

  it("removes the worktree and its branch", async () => {
    const repo = await createRepo();
    const worktree = await createSessionWorktree(repo);

    await removeSessionWorktree({ path: worktree.path });

    expect(await listWorktrees(repo)).toHaveLength(1);
    expect(git(repo, "branch", "--list", "agent-1")).toBe("");
    expect((await getWorktreeStatus(worktree.path)).exists).toBe(false);
  });

  it("refuses to remove the main repository", async () => {
    const repo = await createRepo();

    await expect(removeSessionWorktree({ path: repo })).rejects.toThrow(
      /repositório principal/u,
    );
  });

  it("keeps a branch the worktree was moved off of", async () => {
    const repo = await createRepo();
    const worktree = await createSessionWorktree(repo);
    git(worktree.path, "switch", "-c", "feature", "-q");

    await removeSessionWorktree({
      path: worktree.path,
      branch: worktree.branch,
    });

    // A pasta sai, mas nenhuma branch: `agent-1` não era mais a que estava em
    // check-out, e `feature` é trabalho que o usuário criou por conta própria.
    expect(await listWorktrees(repo)).toHaveLength(1);
    expect(git(repo, "branch", "--list", "agent-1")).toContain("agent-1");
    expect(git(repo, "branch", "--list", "feature")).toContain("feature");
  });

  it("hands out different numbers to worktrees created at once", async () => {
    const repo = await createRepo();

    const created = await Promise.all([
      createSessionWorktree(repo),
      createSessionWorktree(repo),
      createSessionWorktree(repo),
    ]);

    expect(new Set(created.map((item) => item.branch)).size).toBe(3);
    expect(await listWorktrees(repo)).toHaveLength(4);
  });

  it("finds the main repository when the git dir lives elsewhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "ht-wt-sep-"));
    cleanup.push(root);
    const repo = join(root, "repo");
    const gitDir = join(root, "gitdir");
    await mkdir(repo);
    execFileSync("git", ["init", "-q", `--separate-git-dir=${gitDir}`, repo]);
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "commit.gpgsign", "false");
    commit(repo, "initial");
    const root_ = git(repo, "rev-parse", "--show-toplevel");

    const identity = await resolveRepoIdentity(root_);

    // Recortar `/.git` do common dir, ou confiar no `worktree list` (que aqui
    // devolve a pasta do git), apontaria para fora do working tree — e a árvore
    // nova nasceria lá dentro.
    expect(identity).toMatchObject({
      worktreeRoot: root_,
      mainRepoRoot: root_,
      isLinkedWorktree: false,
    });
    const worktree = await createSessionWorktree(root_);
    expect(worktree.path).toBe(`${root_}-agent-1`);
  });

  it("copies an ignored file whose name is not plain ASCII", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, ".gitignore"), "*.local.json\n");
    git(repo, "add", ".gitignore");
    commit(repo, "ignore rules");
    // Com `core.quotePath` (o padrão) o git escaparia este nome em octal.
    await writeFile(join(repo, "configuração.local.json"), "{}\n");

    const worktree = await createSessionWorktree(repo);

    expect(worktree.copiedFiles).toBe(1);
    await expect(
      readFile(join(worktree.path, "configuração.local.json"), "utf8"),
    ).resolves.toBe("{}\n");
  });

  it("needs force to drop a worktree with uncommitted work", async () => {
    const repo = await createRepo();
    const worktree = await createSessionWorktree(repo);
    await writeFile(join(worktree.path, "scratch.txt"), "wip\n");

    await expect(removeSessionWorktree({ path: worktree.path })).rejects.toThrow();

    await removeSessionWorktree({ path: worktree.path, force: true });
    expect(await listWorktrees(repo)).toHaveLength(1);
  });
});

describe("hasWorkInProgress", () => {
  const header = "## agent-1";

  it("ignores Finder noise but not real untracked or modified files", () => {
    expect(hasWorkInProgress(`${header}\n?? .DS_Store\n?? src/.DS_Store\n?? ._notes.md`)).toBe(false);
    expect(hasWorkInProgress(`${header}\n?? .DS_Store\n?? scratch.txt`)).toBe(true);
    expect(hasWorkInProgress(`${header}\n M src/index.ts`)).toBe(true);
    expect(hasWorkInProgress(`${header}\n`)).toBe(false);
  });

  it("does not mistake a tracked .DS_Store change for noise", () => {
    expect(hasWorkInProgress(`${header}\n M .DS_Store`)).toBe(true);
  });
});

describe("samePath (worktree)", () => {
  it("folds case on Windows and macOS only", () => {
    expect(samePath("/Users/x/Repo", "/Users/x/repo", "darwin")).toBe(true);
    expect(samePath("C:/x/Repo", "c:/x/repo", "win32")).toBe(true);
    expect(samePath("/home/x/Repo", "/home/x/repo", "linux")).toBe(false);
  });
});
