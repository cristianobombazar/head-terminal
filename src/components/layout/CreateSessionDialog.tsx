import { useEffect, useState } from "react";

import {
  LLAMA_HARDWARE_PROFILE,
  ORNITH_DEFAULT_GGUF,
  ORNITH_HF_FILE,
  ORNITH_HF_REPO,
  QWEN27_DEFAULT_GGUF,
  QWEN27_HF_FILE,
  buildAgentProfiles,
  sanitizeGgufPath,
} from "../../config/agents";
import {
  WINDOWS_ORNITH_DEFAULT_GGUF,
  WINDOWS_QWEN27_DEFAULT_GGUF,
} from "../../config/agents-windows";
import { isWindowsHost } from "../../core/platform-info";
import { planWorktree } from "../../core/worktree";
import { msg } from "../../i18n";
import type { WorktreeRef } from "../../types/session";
import type { WorktreePlan } from "../../../electron/types/api";

/** The conventional GGUF location, spelled for this host's shell. */
function defaultGgufFor(agentId: string): string {
  if (isWindowsHost()) {
    return agentId === "ornith" ? WINDOWS_ORNITH_DEFAULT_GGUF : WINDOWS_QWEN27_DEFAULT_GGUF;
  }
  return agentId === "ornith" ? ORNITH_DEFAULT_GGUF : QWEN27_DEFAULT_GGUF;
}
import {
  DEFAULT_CLAUDE_ACCOUNT_ID,
  loadClaudeAccountProfiles,
  type ClaudeAccountProfile,
} from "../../core/claude-accounts";
import {
  loadLastAgent,
  loadLastClaudeAccount,
  loadLastGgufPath,
  loadLastOllamaModel,
  loadLastOllamaThinkOff,
  loadLastWslDistro,
  loadRecentCwds,
  noteRecentCwd,
  saveLastAgent,
  saveLastClaudeAccount,
  saveLastGgufPath,
  saveLastOllamaModel,
  saveLastOllamaThinkOff,
  saveLastWslDistro,
  type LlamaAgentId,
} from "../../core/ui-preferences";
import {
  IconActivity,
  IconAgentClaude,
  IconAgentCodex,
  IconAgentCursor,
  IconAgentOllama,
  IconAgentOrnith,
  IconAgentQwen,
  IconAgentShell,
  IconClose,
  IconPlus,
} from "../ui/Icons";

interface CreateSessionDialogProps {
  open: boolean;
  defaultCwd: string;
  onClose: () => void;
  onCreate: (
    cwd: string,
    agentProfileId: string,
    extras?: {
      claudeAccountId?: string;
      ollamaModel?: string;
      ollamaThinkOff?: boolean;
      ggufPath?: string;
      wslDistro?: string;
      worktree?: WorktreeRef;
    },
  ) => void;
}

interface AgentCliStatus {
  antigravity: boolean;
  cursor: boolean;
  claude: boolean;
  codex: boolean;
  ollama: boolean;
  ornith: boolean;
}

const INSTALLABLE_AGENTS = ["claude", "codex", "cursor"] as const;

let cliStatusCache: AgentCliStatus | null = null;
// `ollama list` starts the daemon on a cold machine, so the answer is kept
// for the app's lifetime like the CLI probe above.
let ollamaModelsCache: string[] | null = null;
// Distributions only change when the user installs one; kept the same way.
let wslDistrosCache: string[] | null = null;

function cliAvailable(status: AgentCliStatus, id: string): boolean {
  if (id === "shell") {
    return true;
  }
  // Same llama-cli binary as Ornith; not a separate probe.
  if (id === "qwen27") {
    return status.ornith;
  }
  return status[id as keyof AgentCliStatus] ?? true;
}

function folderChipLabel(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments.at(-1) ?? path;
}

function AgentIcon({ id }: { id: string }) {
  if (id === "antigravity") return <IconActivity size={18} />;
  if (id === "claude") return <IconAgentClaude size={18} />;
  if (id === "codex") return <IconAgentCodex size={18} />;
  if (id === "ollama") return <IconAgentOllama size={18} />;
  if (id === "ornith") return <IconAgentOrnith size={18} />;
  if (id === "qwen27") return <IconAgentQwen size={18} />;
  if (id === "shell") return <IconAgentShell size={18} />;
  return <IconAgentCursor size={18} />;
}

function isLlamaAgent(id: string): id is LlamaAgentId {
  return id === "ornith" || id === "qwen27";
}

function LlamaGgufFields({
  agentId,
  ggufPath,
  onGgufPath,
  hardwareDetail,
  downloadHint,
}: {
  agentId: LlamaAgentId;
  ggufPath: string;
  onGgufPath: (path: string) => void;
  hardwareDetail: string;
  downloadHint: string;
}) {
  const placeholder =
    defaultGgufFor(agentId);

  const browseGguf = async () => {
    const selected = await window.headTerminal.system.selectFile(
      ggufPath.trim() || undefined,
    );
    if (typeof selected === "string") {
      onGgufPath(selected);
    }
  };

  return (
    <fieldset className="create-session-dialog__fieldset">
      <legend>{msg.createSession.ggufModel}</legend>
      <label className="create-session-dialog__field">
        <span>{msg.createSession.ggufFile}</span>
        <div className="create-session-dialog__cwd-row">
          <input
            type="text"
            value={ggufPath}
            onChange={(event) => onGgufPath(event.target.value)}
            placeholder={placeholder}
            spellCheck={false}
          />
          <button
            type="button"
            className="agent-toolbar__button--ghost"
            onClick={() => void browseGguf()}
          >
            {msg.createSession.browse}
          </button>
        </div>
      </label>
      <div className="create-session-dialog__hw">
        <strong>{LLAMA_HARDWARE_PROFILE}</strong>
        <span>{hardwareDetail}</span>
      </div>
      <span className="create-session-dialog__hint">{downloadHint}</span>
    </fieldset>
  );
}

export function CreateSessionDialog({
  open,
  defaultCwd,
  onClose,
  onCreate,
}: CreateSessionDialogProps) {
  const [cwd, setCwd] = useState(defaultCwd);
  const [agentProfileId, setAgentProfileId] = useState("cursor");
  const [claudeAccountId, setClaudeAccountId] = useState(
    DEFAULT_CLAUDE_ACCOUNT_ID,
  );
  const [claudeAccounts, setClaudeAccounts] = useState<ClaudeAccountProfile[]>(
    [],
  );
  const [cwdError, setCwdError] = useState<string | null>(null);
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const [cliStatus, setCliStatus] = useState<AgentCliStatus | null>(null);
  const [ensuringClis, setEnsuringClis] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaModel, setOllamaModel] = useState("");
  const [ollamaThinkOff, setOllamaThinkOff] = useState(false);
  const [ggufPath, setGgufPath] = useState("");
  // null while `wsl -l` is still answering.
  const [wslDistros, setWslDistros] = useState<string[] | null>(null);
  // "" is PowerShell; anything else is the WSL distribution to open.
  const [wslDistro, setWslDistro] = useState("");
  const [worktreePlan, setWorktreePlan] = useState<WorktreePlan | null>(null);
  // `null` enquanto ninguém mexeu no checkbox: aí vale o que o plano sugeriu.
  // Depois de uma decisão manual, ela manda até o diálogo fechar.
  const [worktreeChoice, setWorktreeChoice] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        event.stopImmediatePropagation();
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // A pasta digitada é consultada com atraso: o plano dispara um `git` por
  // sessão aberta, e não faz sentido rodar isso a cada tecla.
  useEffect(() => {
    if (!open) {
      return;
    }
    const target = cwd.trim() || defaultCwd;
    // A escolha manual valia para a pasta anterior. Mantê-la aqui deixaria um
    // "isolar" marcado apontando para algo que talvez nem seja repositório.
    setWorktreeChoice(null);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void planWorktree(target)
        .then((plan) => {
          if (!cancelled) {
            setWorktreePlan(plan);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setWorktreePlan(null);
          }
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cwd, defaultCwd, open]);

  useEffect(() => {
    if (open) {
      const accounts = loadClaudeAccountProfiles();
      const lastAgent = loadLastAgent();
      const lastAccount = loadLastClaudeAccount();
      setCwd(defaultCwd);
      setCwdError(null);
      setWorktreePlan(null);
      setWorktreeChoice(null);
      setCreating(false);
      setClaudeAccounts(accounts);
      setAgentProfileId(
        ["antigravity", "cursor", "claude", "codex", "ollama", "ornith", "qwen27", "shell"].includes(
          lastAgent,
        )
          ? lastAgent
          : "cursor",
      );
      setClaudeAccountId(
        accounts.some((account) => account.id === lastAccount)
          ? lastAccount
          : DEFAULT_CLAUDE_ACCOUNT_ID,
      );
      setOllamaModel(loadLastOllamaModel());
      setOllamaThinkOff(loadLastOllamaThinkOff());
      setGgufPath(
        isLlamaAgent(lastAgent)
          ? loadLastGgufPath(lastAgent) || (
            defaultGgufFor(lastAgent)
          )
          : "",
      );
      setRecentCwds(loadRecentCwds());
      setWslDistro(loadLastWslDistro());
      if (cliStatusCache) {
        setCliStatus(cliStatusCache);
      }
      setEnsuringClis(true);
      void window.headTerminal.system.ensureAgentClis()
        .then((result) => {
          cliStatusCache = result.status;
          setCliStatus(result.status);
          if (
            lastAgent !== "shell" &&
            !cliAvailable(result.status, lastAgent)
          ) {
            setAgentProfileId(result.status.cursor ? "cursor" : "shell");
          }
        })
        .catch(() =>
          window.headTerminal.system.checkAgentClis().then((status) => {
            cliStatusCache = status;
            setCliStatus(status);
            if (
              lastAgent !== "shell" &&
              !cliAvailable(status, lastAgent)
            ) {
              setAgentProfileId(status.cursor ? "cursor" : "shell");
            }
          }).catch(() => {
            const none: AgentCliStatus = {
              antigravity: false,
              cursor: false,
              claude: false,
              codex: false,
              ollama: false,
              ornith: false,
            };
            setCliStatus(none);
            setAgentProfileId("shell");
          }),
        )
        .finally(() => setEnsuringClis(false));
    }
  }, [defaultCwd, open]);

  // Only asked for once the user actually wants a local model: the call
  // wakes the ollama daemon, which is not something opening the dialog
  // should do on its own.
  useEffect(() => {
    if (!open || agentProfileId !== "ollama") {
      return;
    }
    let cancelled = false;
    const apply = (models: string[]) => {
      if (cancelled) {
        return;
      }
      setOllamaModels(models);
      setOllamaModel((current) =>
        current || models[0] || "",
      );
    };
    if (ollamaModelsCache) {
      apply(ollamaModelsCache);
      return;
    }
    void window.headTerminal.system.listOllamaModels()
      .then((models) => {
        ollamaModelsCache = models;
        apply(models);
      })
      .catch(() => apply([]));
    return () => {
      cancelled = true;
    };
  }, [agentProfileId, open]);

  // Asked for only once a plain shell is picked on Windows. A remembered
  // distribution that is no longer installed falls back to PowerShell.
  useEffect(() => {
    if (!open || agentProfileId !== "shell" || !isWindowsHost()) {
      return;
    }
    let cancelled = false;
    const apply = (distros: string[]) => {
      if (cancelled) {
        return;
      }
      setWslDistros(distros);
      setWslDistro((current) => (distros.includes(current) ? current : ""));
    };
    if (wslDistrosCache) {
      apply(wslDistrosCache);
      return;
    }
    void window.headTerminal.system.listWslDistros()
      .then((distros) => {
        wslDistrosCache = distros;
        apply(distros);
      })
      .catch(() => apply([]));
    return () => {
      cancelled = true;
    };
  }, [agentProfileId, open]);

  if (!open) {
    return null;
  }

  // Sem decisão manual, vale a recomendação do plano.
  const isolateInWorktree =
    Boolean(worktreePlan?.isRepo) &&
    (worktreeChoice ?? worktreePlan?.recommended ?? false);

  const profiles = Object.values(buildAgentProfiles());
  const profileLabel = (id: string): string =>
    profiles.find((profile) => profile.id === id)?.label ?? id;

  // Only the CLIs `ensureAgentClis` knows how to install; Ollama, llama.cpp
  // and Antigravity stay "not installed" with their own hints.
  const missingInstallable = cliStatus
    ? INSTALLABLE_AGENTS.filter((id) => !cliAvailable(cliStatus, id))
    : [];

  const retryInstall = async () => {
    if (ensuringClis) {
      return;
    }
    setEnsuringClis(true);
    try {
      const result = await window.headTerminal.system.ensureAgentClis();
      cliStatusCache = result.status;
      setCliStatus(result.status);
    } catch {
      // The row stays; the user can try again.
    } finally {
      setEnsuringClis(false);
    }
  };

  const isAgentAvailable = (id: string): boolean => {
    if (id === "shell") {
      return true;
    }
    if (!cliStatus) {
      return false;
    }
    return cliAvailable(cliStatus, id);
  };

  const validateAndCreate = async () => {
    if (creating) {
      return;
    }
    setCreating(true);
    const nextCwd = cwd.trim() || defaultCwd;
    let exists = false;
    try {
      exists = await window.headTerminal.system.pathExists(nextCwd);
    } catch {
      setCwdError(msg.createSession.directoryUnreachable);
      setCreating(false);
      return;
    }
    if (!exists) {
      setCwdError(msg.createSession.directoryNotFound);
      setCreating(false);
      return;
    }

    // O plano da tela roda com atraso e pode estar velho; o da hora de criar é
    // que vale. Fora de um repositório não há o que isolar, marcado ou não.
    let isolate = false;
    try {
      const plan = await planWorktree(nextCwd);
      isolate = plan.isRepo && (worktreeChoice ?? plan.recommended);
    } catch {
      isolate = false;
    }

    let sessionCwd = nextCwd;
    let worktree: WorktreeRef | undefined;
    if (isolate) {
      try {
        const info = await window.headTerminal.git.createWorktree(nextCwd, {
          copyIgnored: true,
        });
        sessionCwd = info.path;
        worktree = {
          path: info.path,
          branch: info.branch,
          mainRepoRoot: info.mainRepoRoot,
        };
      } catch (error) {
        setCwdError(msg.createSession.worktreeFailed(String(error)));
        setCreating(false);
        return;
      }
    }

    noteRecentCwd(nextCwd);
    saveLastAgent(agentProfileId);
    if (agentProfileId === "claude") {
      saveLastClaudeAccount(claudeAccountId);
    }
    if (agentProfileId === "ollama") {
      saveLastOllamaModel(ollamaModel);
      saveLastOllamaThinkOff(ollamaThinkOff);
    }
    if (isLlamaAgent(agentProfileId)) {
      saveLastGgufPath(agentProfileId, ggufPath);
    }
    const shellOnWsl = agentProfileId === "shell" && isWindowsHost();
    if (shellOnWsl) {
      saveLastWslDistro(wslDistro);
    }
    onCreate(sessionCwd, agentProfileId, {
      claudeAccountId:
        agentProfileId === "claude" ? claudeAccountId : undefined,
      ollamaModel:
        agentProfileId === "ollama" ? ollamaModel.trim() : undefined,
      ollamaThinkOff:
        agentProfileId === "ollama" ? ollamaThinkOff : undefined,
      ggufPath: isLlamaAgent(agentProfileId)
        ? sanitizeGgufPath(ggufPath)
        : undefined,
      wslDistro: shellOnWsl && wslDistro ? wslDistro : undefined,
      worktree,
    });
    onClose();
  };

  const browseDirectory = async () => {
    const selected = await window.headTerminal.system.selectDirectory(
      cwd || defaultCwd,
    );
    if (typeof selected === "string") {
      setCwd(selected);
      setCwdError(null);
    }
  };

  return (
    <div className="create-session-backdrop" onClick={onClose}>
      <div
        className="create-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-session-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="create-session-dialog__header">
          <div>
            <h2 id="create-session-title" className="create-session-dialog__title">
              {msg.createSession.title}
            </h2>
            <p>{msg.createSession.subtitle}</p>
          </div>
          <button
            type="button"
            className="create-session-dialog__close"
            aria-label={msg.createSession.closeAria}
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </header>

        <div className="create-session-dialog__body">
          <label className="create-session-dialog__field">
          <span>{msg.createSession.directory}</span>
          <div className="create-session-dialog__cwd-row">
            <input
              type="text"
              value={cwd}
              onChange={(event) => {
                setCwd(event.target.value);
                setCwdError(null);
              }}
              placeholder={msg.createSession.directoryPlaceholder}
            />
            <button
              type="button"
              className="agent-toolbar__button--ghost"
              onClick={() => void browseDirectory()}
            >
              {msg.createSession.browse}
            </button>
          </div>
          {cwdError && (
            <span className="create-session-dialog__error">{cwdError}</span>
          )}
          </label>

        {recentCwds.length > 0 && (
          <div className="create-session-dialog__recent">
            {recentCwds.map((item) => (
              <button
                key={item}
                type="button"
                className="create-session-dialog__chip"
                title={item}
                onClick={() => {
                  setCwd(item);
                  setCwdError(null);
                }}
              >
                {folderChipLabel(item)}
              </button>
            ))}
          </div>
        )}

        {worktreePlan?.isRepo && (
          <label className="create-session-dialog__worktree">
            <input
              type="checkbox"
              checked={isolateInWorktree}
              onChange={(event) => setWorktreeChoice(event.target.checked)}
            />
            <span>
              <strong>
                {worktreePlan.recommended
                  ? msg.createSession.worktreeRecommended
                  : msg.createSession.worktree}
              </strong>
              {worktreePlan.recommended
                ? msg.createSession.worktreeBusy(worktreePlan.occupants)
                : msg.createSession.worktreeFree}
            </span>
          </label>
        )}

        <fieldset className="create-session-dialog__fieldset">
          <legend>{msg.createSession.agent}</legend>
          <div className="create-session-dialog__agents">
            {profiles.map((profile) => {
              const available = isAgentAvailable(profile.id);
              const installing = ensuringClis
                && profile.id !== "shell"
                && profile.id !== "antigravity"
                && !available;
              const cardClass = [
                "create-session-dialog__agent",
                profile.id === agentProfileId && "create-session-dialog__agent--active",
                !available && !installing && "create-session-dialog__agent--unavailable",
                installing && "create-session-dialog__agent--installing",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  key={profile.id}
                  type="button"
                  className={cardClass}
                  disabled={!available}
                  aria-pressed={profile.id === agentProfileId}
                  onClick={() => {
                    setAgentProfileId(profile.id);
                    if (isLlamaAgent(profile.id)) {
                      setGgufPath(
                        loadLastGgufPath(profile.id)
                          || (defaultGgufFor(profile.id)),
                      );
                    }
                  }}
                >
                  <AgentIcon id={profile.id} />
                  <span>{profile.label}</span>
                  {installing && <small>{msg.createSession.installing}</small>}
                  {!available && !installing && <small>{msg.createSession.notInstalled}</small>}
                </button>
              );
            })}
          </div>
          {missingInstallable.length > 0 && (
            <div className="create-session-dialog__install">
              <span>
                {ensuringClis
                  ? msg.createSession.installingMissing
                  : msg.createSession.notInstalledList(
                      missingInstallable.map((id) => profileLabel(id)).join(", "),
                    )}
              </span>
              <button
                type="button"
                disabled={ensuringClis}
                onClick={() => void retryInstall()}
              >
                {ensuringClis ? msg.createSession.installing : msg.createSession.installNow}
              </button>
            </div>
          )}
        </fieldset>

        {agentProfileId === "ollama" && (
          <fieldset className="create-session-dialog__fieldset">
            <legend>{msg.createSession.localModel}</legend>
            {ollamaModels.length > 0 && (
              <div className="create-session-dialog__profiles">
                {ollamaModels.map((model) => (
                  <button
                    key={model}
                    type="button"
                    className={
                      model === ollamaModel.trim()
                        ? "create-session-dialog__profile create-session-dialog__profile--active"
                        : "create-session-dialog__profile"
                    }
                    aria-pressed={model === ollamaModel.trim()}
                    onClick={() => setOllamaModel(model)}
                  >
                    <span>{model}</span>
                    <small>ollama run</small>
                  </button>
                ))}
              </div>
            )}
            <label className="create-session-dialog__field">
              <span>{msg.createSession.otherModel}</span>
              <input
                type="text"
                value={ollamaModel}
                onChange={(event) => setOllamaModel(event.target.value)}
                placeholder="qwen38-27b-uncensored:latest"
              />
            </label>
            <label className="create-session-dialog__worktree">
              <input
                type="checkbox"
                checked={ollamaThinkOff}
                onChange={(event) => setOllamaThinkOff(event.target.checked)}
              />
              <span>
                <strong>{msg.createSession.thinkingOff}</strong>
                {msg.createSession.thinkingOffHint}
              </span>
            </label>
            <span className="create-session-dialog__hint">
              {ollamaModels.length > 0
                ? msg.createSession.modelRemembered
                : msg.createSession.noModels}
            </span>
          </fieldset>
        )}

        {agentProfileId === "ornith" && (
          <LlamaGgufFields
            agentId="ornith"
            ggufPath={ggufPath}
            onGgufPath={setGgufPath}
            hardwareDetail={msg.createSession.ornithHardware}
            downloadHint={msg.createSession.ggufDownloadHint(ORNITH_HF_FILE, ORNITH_HF_REPO)}
          />
        )}

        {agentProfileId === "qwen27" && (
          <LlamaGgufFields
            agentId="qwen27"
            ggufPath={ggufPath}
            onGgufPath={setGgufPath}
            hardwareDetail={msg.createSession.qwenHardware}
            downloadHint={msg.createSession.ggufDownloadHint(QWEN27_HF_FILE)}
          />
        )}

        {agentProfileId === "shell" && isWindowsHost() && (
          <fieldset className="create-session-dialog__fieldset">
            <legend>{msg.createSession.whereToOpen}</legend>
            <div className="create-session-dialog__profiles">
              {["", ...(wslDistros ?? [])].map((distro) => (
                <button
                  key={distro || "powershell"}
                  type="button"
                  className={
                    distro === wslDistro
                      ? "create-session-dialog__profile create-session-dialog__profile--active"
                      : "create-session-dialog__profile"
                  }
                  aria-pressed={distro === wslDistro}
                  onClick={() => setWslDistro(distro)}
                >
                  <span>{distro || "PowerShell"}</span>
                  <small>{distro ? "WSL" : "Windows"}</small>
                </button>
              ))}
            </div>
            <span className="create-session-dialog__hint">
              {wslDistros === null
                ? msg.createSession.searchingWsl
                : wslDistros.length > 0
                  ? msg.createSession.choiceRemembered
                  : msg.createSession.noWsl}
            </span>
          </fieldset>
        )}

        {agentProfileId === "claude" && (
          <fieldset className="create-session-dialog__fieldset">
            <legend>{msg.createSession.claudeProfile}</legend>
            <div className="create-session-dialog__profiles">
              {claudeAccounts.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  className={
                    account.id === claudeAccountId
                      ? "create-session-dialog__profile create-session-dialog__profile--active"
                      : "create-session-dialog__profile"
                  }
                  aria-pressed={account.id === claudeAccountId}
                  onClick={() => setClaudeAccountId(account.id)}
                >
                  <span>{account.name}</span>
                  <small>
                    {account.id === DEFAULT_CLAUDE_ACCOUNT_ID
                      ? msg.createSession.claudeDefaultProfile
                      : msg.createSession.claudeIsolatedProfile}
                  </small>
                </button>
              ))}
            </div>
            <span className="create-session-dialog__hint">
              {msg.createSession.profileRemembered}
            </span>
          </fieldset>
        )}
        </div>

        <div className="create-session-dialog__actions">
          <button type="button" className="agent-toolbar__button--ghost" onClick={onClose}>
            {msg.createSession.cancel}
          </button>
          <button
            type="button"
            className="create-session-dialog__create"
            disabled={
              creating
              || !isAgentAvailable(agentProfileId)
              || (agentProfileId === "claude" && !claudeAccountId)
              || (agentProfileId === "ollama" && !ollamaModel.trim())
              || (isLlamaAgent(agentProfileId) && !sanitizeGgufPath(ggufPath))
            }
            onClick={() => void validateAndCreate()}
          >
            <IconPlus size={14} />
            {creating ? msg.createSession.creating : msg.createSession.create}
          </button>
        </div>
      </div>
    </div>
  );
}
