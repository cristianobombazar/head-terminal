import { createInitialSession } from "../core/agent-launcher";
import { useSessionStore } from "../core/session-manager";
import { createIsolatedWorktree, planWorktree } from "../core/worktree";
import type { AgentSession, WorktreeRef } from "../types/session";

/** Duplica uma sessão sem jogar a cópia na árvore que a original já ocupa.
 *
 * Duplicar era o caminho mais curto para dois agents no mesmo working tree —
 * mesma pasta, mesmo index, mesmo `git status`. Quando a árvore está ocupada, a
 * cópia nasce num worktree próprio; quando não está (a original já se isolou,
 * ou nem é repositório), ela abre a mesma pasta como antes. */
export async function duplicateSessionIsolated(
  session: AgentSession,
): Promise<void> {
  let cwd = session.cwd;
  let worktree: WorktreeRef | undefined;

  const plan = await planWorktree(session.cwd).catch(() => null);
  if (plan?.recommended) {
    const created = await createIsolatedWorktree(session.cwd);
    if (created) {
      cwd = created.path;
      worktree = created;
    }
  }

  useSessionStore.getState().addSession(
    createInitialSession(
      cwd,
      `${session.title} (cópia)`,
      session.agentProfileId,
      {
        claudeAccountId: session.claudeAccountId,
        ollamaModel: session.ollamaModel,
        ollamaThinkOff: session.ollamaThinkOff,
        ggufPath: session.ggufPath,
        wslDistro: session.wslDistro,
        worktree,
      },
    ),
  );
}
