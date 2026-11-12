// Icone simboliche 16px in stile "symbolic" GNOME/Yaru (tratto singolo, colore corrente)
const ICON_PATHS = {
  sidebar: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6 3v10"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  chevronDown: '<path d="M4.5 6.5 8 10l3.5-3.5"/>',
  chevronRight: '<path d="M6.5 4.5 10 8l-3.5 3.5"/>',
  chevronLeft: '<path d="M9.5 4.5 6 8l3.5 3.5"/>',
  chevronUp: '<path d="M4.5 9.5 8 6l3.5 3.5"/>',
  splitH: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M8 3v10"/>',
  splitV: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 8h12"/>',
  menu: '<path d="M3 4.5h10M3 8h10M3 11.5h10"/>',
  minimize: '<path d="M4.5 8h7"/>',
  maximize: '<rect x="4.5" y="4.5" width="7" height="7" rx="1"/>',
  restore: '<rect x="4" y="6" width="6" height="6" rx="1"/><path d="M6 4h5a1 1 0 0 1 1 1v5"/>',
  close: '<path d="M5 5l6 6M11 5l-6 6"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/>',
  folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>',
  file: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>',
  up: '<path d="M8 13V4M4 7.5 8 3.5l4 4"/>',
  star: '<path d="m8 2.5 1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11.1l-3.4 1.8.7-3.8-2.8-2.6 3.8-.5z"/>',
  starFilled: '<path fill="currentColor" d="m8 2.5 1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11.1l-3.4 1.8.7-3.8-2.8-2.6 3.8-.5z"/>',
  external: '<path d="M9 3h4v4M13 3 7.5 8.5"/><path d="M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  eyeOff: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><path d="M2.5 2.5l11 11"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
  drive: '<rect x="2" y="5" width="12" height="6" rx="1.5"/><path d="M11 8h.01"/>',
  terminal: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="m5 6.5 2 1.5-2 1.5M8.5 10h2.5"/>',
  zoom: '<path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"/>',
  unzoom: '<path d="M6 3v3H3M10 3v3h3M6 13v-3H3M10 13v-3h3"/>',
  command: '<path d="M5.5 3.5a2 2 0 1 0 0 4h5a2 2 0 1 0 0-4v9a2 2 0 1 0 0-4h-5a2 2 0 1 0 0 4z"/>',
  copy: '<rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 10.5V4a1 1 0 0 1 1-1h6.5"/>',
  paste: '<rect x="3.5" y="3.5" width="9" height="10" rx="1.5"/><path d="M6 3.5V2.5h4v1"/>',
  home: '<path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3V10h2v3h3V6.5"/>',
  jump: '<path d="M3 8h8M8 4.5 11.5 8 8 11.5"/><path d="M13.5 3v10"/>',
  ps: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="m4.5 6 2.5 2-2.5 2M8.5 10.5h3"/>',
  cmd: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M4.5 9.5h1.5M7.5 6.5l-1 4"/>',
  bash: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 6v4M5 8h1.5a1 1 0 0 0 0-2H5M5 8h2a1 1 0 0 1 0 2H5"/>',
  linux: '<path d="M8 2.5c-1.6 0-2.3 1.4-2.3 3 0 1-.9 2-1.7 3.4-.8 1.4-.7 3 .3 3.6h7.4c1-.6 1.1-2.2.3-3.6-.8-1.4-1.7-2.4-1.7-3.4 0-1.6-.7-3-2.3-3z"/>'
};

function icon(name, cls = '') {
  const p = ICON_PATHS[name] || '';
  return `<svg class="ico ${cls}" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
