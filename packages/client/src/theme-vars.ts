(function () {
  const tokens = window.CentraidTokens;
  if (!tokens?.cssText) {
    console.error(
      "CentraidTokens.cssText missing — design-tokens preload may be stale."
    );
    return;
  }
  const style = document.createElement("style");
  style.id = "centraid-tokens";
  style.textContent = tokens.cssText;
  document.head.prepend(style);
})();
