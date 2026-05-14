// Centraid theme bridge — runs synchronously before paint inside the
// app iframe. Reads the initial theme from the URL hash the renderer
// appends (#theme=dark&bgL=10), then keeps the document in sync with
// the shell via postMessage as the user flips dark/light or drags the
// Dark-shade slider. Must be loaded with a plain <script> tag (no
// type=module, no defer) so it executes before the stylesheet paints.
(function () {
  var h = document.documentElement;
  function apply(theme, bgL) {
    if (theme === 'dark' || theme === 'light') h.dataset.theme = theme;
    if (bgL != null && bgL !== '') h.style.setProperty('--bg-l', bgL + '%');
  }
  try {
    var p = new URLSearchParams((location.hash || '').slice(1));
    apply(p.get('theme'), p.get('bgL'));
  } catch (_) {
    /* noop */
  }
  addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.type !== 'centraid:theme') return;
    apply(d.theme, d.bgL);
  });
})();
