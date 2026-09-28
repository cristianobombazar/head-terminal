import { Menu, type MenuItemConstructorOptions } from "electron";

import { msg } from "../src/i18n";

/**
 * macOS needs an application menu: without one Electron installs its default,
 * whose accelerators collide with a terminal — ⌘W closes the whole window
 * while ⌘⇧W closes a pane, ⌘R reloads the renderer and takes every PTY with
 * it, ⌘= / ⌘- zoom the page instead of the terminal font. The menu here keeps
 * what the platform expects (the app menu, Edit with the clipboard roles that
 * make ⌘C / ⌘V work in inputs, Window) and leaves every other key to the app.
 *
 * Windows and Linux keep their default menu bar untouched; this is never
 * installed there.
 */
export function buildMacApplicationMenu(options: {
  appName: string;
  development: boolean;
}): Menu {
  const view: MenuItemConstructorOptions[] = [{ role: "togglefullscreen" }];
  if (options.development) {
    view.unshift({ role: "toggleDevTools" }, { type: "separator" });
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: options.appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      // Its keys stay registered — `registerAccelerator: false` is honored
      // on Windows and Linux only. They don't get in the way because
      // Chromium hands a ⌘ key to the page first and the menu only sees the
      // ones the page did not prevent: every app shortcut prevents what it
      // handles (⌘⇧Z expands a pane rather than Redo), and what is left
      // (⌘Z / ⌘X / ⌘C / ⌘A in an input or a pane) is what these items do.
      role: "editMenu",
      submenu: (
        ["undo", "redo", "cut", "copy", "paste", "selectAll"] as const
      ).map((role) => ({ role })),
    },
    { label: msg.main.menu.view, submenu: view },
    {
      role: "windowMenu",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
    },
  ];

  return Menu.buildFromTemplate(template);
}
