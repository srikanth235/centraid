// Icon glyphs — trusted inner-SVG path markup, keyed by name. Sizes / stroke
// width / fill vary per call site (a 12px star in a list row, a 30px lock
// mark on the lock screen, a 26px shield in Watchtower's header, …) so these
// are just the <path>/<rect>/<circle> fragments; components/Shared.jsx's
// <Icon>/<CatIcon> wrap them in an outer <svg> sized for the call site — the
// React analogue of app.js's `iconSvg()`/`catIconSvg()` helpers.
export const ICON_PATHS = {
  lock: '<path d="M8 11V8a4 4 0 018 0v3"></path><rect x="5" y="11" width="14" height="10" rx="2"></rect>',
  plus: '<path d="M12 5v14M5 12h14"></path>',
  close: '<path d="M6 6l12 12M18 6 6 18"></path>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"></path>',
  search: '<circle cx="11" cy="11" r="7"></circle><path d="m21 21-4.3-4.3"></path>',
  back: '<path d="m15 6-6 6 6 6"></path>',
  edit: '<path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17z"></path>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h8"></path>',
  eye: '<circle cx="12" cy="12" r="3"></circle><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path>',
  eyeOff:
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path><path d="m4 4 16 16"></path>',
  regen:
    '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path><path d="M3 21v-5h5"></path>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"></path>',
  tag: '<path d="M4 4h7l9 9-7 7-9-9z"></path><circle cx="8.5" cy="8.5" r="1.3"></circle>',
  starFill:
    '<path d="m12 3 2.6 5.6 6 .7-4.5 4.2 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.3l6-.7z"></path>',
  sun: '<circle cx="12" cy="12" r="4.5"></circle><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"></path>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"></path>',
  all: '<path d="M4 6h16M4 12h16M4 18h16"></path>',
  shield:
    '<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"></path><path d="m9.5 12 2 2 3.5-3.5"></path>',
};

export const CAT_ICON_PATHS = {
  login:
    '<path d="M15 7a5 5 0 1 0-4.5 5H12l2 2 2-2 1.5-1.5"></path><path d="M11.5 11.5 8 15l-1 3 3-1 3.5-3.5"></path>',
  card: '<path d="M3 7h18v11H3z"></path><path d="M3 11h18"></path>',
  note: '<path d="M6 3h9l4 4v14H6z"></path><path d="M9 12h7M9 16h5M14 3v4h4"></path>',
  identity:
    '<path d="M4 5h16v14H4z"></path><path d="M8 10a2 2 0 1 0 0-.1"></path><path d="M6 16a3 3 0 0 1 6 0"></path><path d="M14 9h4M14 13h4"></path>',
  password: '<path d="M7 12h.01M12 12h.01M17 12h.01"></path><path d="M4 7h16v10H4z"></path>',
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0"></path><path d="M8.5 15.5a5 5 0 0 1 7 0"></path><path d="M12 18.5h.01"></path>',
};
