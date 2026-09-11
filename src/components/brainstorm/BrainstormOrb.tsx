import { useEffect, useRef } from "react";

import { readBrainstormAudioLevel, type BrainstormStatus } from "../../core/live-brainstorm";

/**
 * The brainstorm's presence on screen: a small holographic sphere that
 * breathes with whoever is talking, freezes when the voice pauses and
 * collapses when the conversation ends. Clicking it opens the full panel.
 */

/** How fast the sphere follows the audio level, per frame (0..1). */
const LEVEL_RISE = 0.45;
const LEVEL_FALL = 0.12;

export type OrbMood = "connecting" | "live" | "paused" | "dying" | "error" | "ended";

export function orbMood(status: BrainstormStatus): OrbMood {
  switch (status) {
    case "connecting":
      return "connecting";
    case "live":
      return "live";
    case "paused":
      return "paused";
    case "closing":
    case "ended":
      return "dying";
    case "error":
      return "error";
    default:
      return "ended";
  }
}

interface BrainstormOrbProps {
  mood: OrbMood;
  /** An analysis is running: the outer ring hurries. */
  working?: boolean;
  /** Results arrived while the panel was closed. */
  unread?: number;
  /** A header ornament instead of the floating button. */
  mini?: boolean;
  title?: string;
  onClick?: () => void;
  /** The death animation finished; the orb can leave the page. */
  onDied?: () => void;
}

export function BrainstormOrb({
  mood,
  working = false,
  unread = 0,
  mini = false,
  title,
  onClick,
  onDied,
}: BrainstormOrbProps) {
  const ref = useRef<HTMLButtonElement>(null);

  // The level lives on a CSS variable, set straight on the element once a
  // frame: a store update per frame would re-render the whole panel.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (mood !== "live") {
      element.style.setProperty("--orb-level", "0");
      return;
    }
    let frame = 0;
    let level = 0;
    const tick = () => {
      const target = readBrainstormAudioLevel();
      level += (target - level) * (target > level ? LEVEL_RISE : LEVEL_FALL);
      element.style.setProperty("--orb-level", level.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [mood]);

  const classes = [
    "brainstorm-orb",
    `brainstorm-orb--${mood}`,
    working ? "brainstorm-orb--working" : "",
    mini ? "brainstorm-orb--mini" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={ref}
      type="button"
      className={classes}
      title={title}
      aria-label={title ?? "Brainstorm por voz"}
      onClick={onClick}
      disabled={!onClick}
      onAnimationEnd={(event) => {
        if (event.animationName === "brainstorm-orb-die") onDied?.();
      }}
    >
      <span className="brainstorm-orb__glow" aria-hidden />
      <span className="brainstorm-orb__ring brainstorm-orb__ring--outer" aria-hidden />
      <span className="brainstorm-orb__ring brainstorm-orb__ring--inner" aria-hidden />
      <span className="brainstorm-orb__scan" aria-hidden />
      <span className="brainstorm-orb__core" aria-hidden />
      {mood === "paused" && <span className="brainstorm-orb__pause" aria-hidden />}
      {unread > 0 && !mini && (
        <span className="brainstorm-orb__badge" aria-label={`${unread} resultados novos`}>
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </button>
  );
}
