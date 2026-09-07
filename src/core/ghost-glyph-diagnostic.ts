import type { Terminal } from "@xterm/xterm";

import { logEvent } from "./logger";

/**
 * Diagnóstico dos "caracteres fantasma" nas colunas 0-2 do pane.
 *
 * Duas causas possíveis, com assinaturas distintas:
 *
 * - Renderer (WebGL): o buffer do xterm está limpo, mas o cache de vértices
 *   do addon ficou dessincronizado e continua desenhando glifos antigos.
 *   `clearTextureAtlas()` zera modelo + vértices e redesenha o viewport, então
 *   os fantasmas somem e o relatório mostra `dirtyRows` vazio.
 * - Buffer (ConPTY): o ConPTY não reemitiu a limpeza das colunas iniciais ao
 *   redesenhar a tela do Claude Code, e os caracteres realmente existem no
 *   buffer do xterm. Redesenhar não muda nada e `dirtyRows` lista as linhas.
 */

export const GHOST_PREFIX_COLS = 2;

export interface GhostRowSample {
  /** Linha do viewport (0 = topo). */
  row: number;
  /** Primeiras colunas, sem trim, para inspeção. */
  prefix: string;
  /** Início da linha (até 40 colunas), para localizar no screenshot. */
  text: string;
}

export interface GhostGlyphReport {
  cols: number;
  rows: number;
  viewportY: number;
  renderer: "webgl" | "dom" | "unknown";
  /** Linhas cujo prefixo tem algo que não é espaço/vazio. */
  dirtyRows: GhostRowSample[];
}

export function isBlankPrefix(prefix: string): boolean {
  return prefix.trim().length === 0;
}

export function detectRenderer(element: HTMLElement | undefined): GhostGlyphReport["renderer"] {
  if (!element) {
    return "unknown";
  }
  if (element.querySelector("canvas.xterm-webgl, canvas.xterm-cursor-layer, canvas.xterm-link-layer")) {
    return "webgl";
  }
  if (element.querySelector(".xterm-rows > div")) {
    return "dom";
  }
  return "unknown";
}

export function collectGhostGlyphReport(terminal: Terminal): GhostGlyphReport {
  const buffer = terminal.buffer.active;
  const dirtyRows: GhostRowSample[] = [];

  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    if (!line) {
      continue;
    }
    const prefix = line.translateToString(false, 0, GHOST_PREFIX_COLS);
    if (isBlankPrefix(prefix)) {
      continue;
    }
    dirtyRows.push({
      row: y,
      prefix,
      text: line.translateToString(true, 0, 40),
    });
  }

  return {
    cols: terminal.cols,
    rows: terminal.rows,
    viewportY: buffer.viewportY,
    renderer: detectRenderer(terminal.element ?? undefined),
    dirtyRows,
  };
}

/**
 * Coleta o relatório, força o redesenho completo do renderer e devolve o
 * texto pronto para colar. Rodar com os fantasmas visíveis na tela.
 */
export function runGhostGlyphDiagnostic(paneId: string, terminal: Terminal): string {
  const before = collectGhostGlyphReport(terminal);

  // Zera atlas, modelo e vértices do WebGL e pede um redraw de todo o
  // viewport. No renderer DOM só reconstrói as linhas.
  terminal.clearTextureAtlas();
  terminal.refresh(0, terminal.rows - 1);

  logEvent("info", "terminal.ghost_diagnostic", { paneId, ...before });

  const lines = [
    `Head Terminal — diagnóstico de caracteres fantasma`,
    `pane=${paneId} renderer=${before.renderer} cols=${before.cols} rows=${before.rows} viewportY=${before.viewportY}`,
    before.dirtyRows.length === 0
      ? `buffer: colunas 0-${GHOST_PREFIX_COLS - 1} limpas em todas as linhas visíveis`
      : `buffer: ${before.dirtyRows.length} linha(s) com conteúdo nas colunas 0-${GHOST_PREFIX_COLS - 1}:`,
    ...before.dirtyRows.map(
      (sample) => `  y=${String(sample.row).padStart(2)} prefix=${JSON.stringify(sample.prefix)} | ${sample.text}`,
    ),
    ``,
    `Se os fantasmas SUMIRAM após este comando e o buffer está limpo → problema no renderer WebGL.`,
    `Se CONTINUARAM e as linhas acima os listam → estão no buffer (vindos do ConPTY).`,
  ];
  return lines.join("\n");
}
