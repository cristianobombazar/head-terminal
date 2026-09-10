import { useEffect, useState } from "react";

import type { ResourceUsage } from "../../electron/types/api";

const POLL_INTERVAL_MS = 2_000;

/**
 * CPU/memória da máquina, atualizados a cada 2s.
 *
 * O polling para quando a janela fica oculta (minimizada/outra área de
 * trabalho): o número não está sendo visto e o main já tem PTYs para atender.
 * `null` antes da primeira leitura — e se o IPC falhar, o último valor bom
 * continua na tela em vez de piscar vazio.
 */
export function useResourceUsage(): ResourceUsage | null {
  const [usage, setUsage] = useState<ResourceUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let inFlight = false;

    const read = () => {
      if (inFlight) return;
      inFlight = true;
      window.headTerminal.system
        .getResourceUsage()
        .then((next) => {
          if (!cancelled) setUsage(next);
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };

    const start = () => {
      if (timer !== null) return;
      read();
      timer = window.setInterval(read, POLL_INTERVAL_MS);
    };

    const stop = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    };

    if (!document.hidden) {
      start();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return usage;
}
