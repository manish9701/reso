/** Global action dock: the mounted toy registers pause/clear/export for keyboard shortcuts. */
export interface Dock {
  toggle?: () => void;
  clear?: () => void;
  export?: () => void;
}

export const dock: Dock = {};

export function setDock(d: Dock) {
  dock.toggle = d.toggle;
  dock.clear = d.clear;
  dock.export = d.export;
}
