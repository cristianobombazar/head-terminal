import type { Locale } from "../locale";
import { app } from "./app";
import { brainstorm } from "./brainstorm";
import { core } from "./core";
import { createSession } from "./create-session";
import { main } from "./main";
import { settings } from "./settings";
import { sidebar } from "./sidebar";
import { terminal } from "./terminal";

/** One module per area of the app, each holding both languages side by side. */
const AREAS = {
  app,
  brainstorm,
  core,
  createSession,
  main,
  settings,
  sidebar,
  terminal,
};

type Areas = typeof AREAS;

export type Messages = { [Area in keyof Areas]: Areas[Area]["pt-BR"] };

function inLocale(locale: Locale): Messages {
  return Object.fromEntries(
    Object.entries(AREAS).map(([area, texts]) => [area, texts[locale]]),
  ) as Messages;
}

export const messages: Record<Locale, Messages> = {
  "pt-BR": inLocale("pt-BR"),
  en: inLocale("en"),
};
