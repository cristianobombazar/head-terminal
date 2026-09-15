import { Menu, type MenuItemConstructorOptions } from "electron";

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
      role: "editMenu",
      // The items stay clickable and show their keys, but the keys are not
      // registered: a registered ⌘⇧Z would fire Redo before the page saw the
      // "expand pane" shortcut, and a registered ⌘A would select the page
      // instead of letting xterm select the terminal. Chromium already
      // handles ⌘Z / ⌘X / ⌘C / ⌘V / ⌘A inside inputs on its own, and the
      // terminal's paste surface handles ⌘V in a pane.
      submenu: (
        ["undo", "redo", "cut", "copy", "paste", "selectAll"] as const
      ).map((role) => ({ role, registerAccelerator: false })),
    },
    { label: "View", submenu: view },
    {
      role: "windowMenu",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
    },
  ];

  return Menu.buildFromTemplate(template);
}
