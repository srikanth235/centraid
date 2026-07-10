// Tiny id lookup shared by app.jsx and the plain-JS helper modules that still
// touch the static (non-React-owned) DOM directly — a one-line module purely
// to avoid duplicating this across app.jsx and upload.js/outcomes.js.
export const $ = (id) => document.getElementById(id);
