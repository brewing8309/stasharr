/*
 * Injected by background.js into pages on the configured Stash URL's host.
 * On the exact Stash origin (match patterns can't hold a port, so the
 * pattern alone isn't enough), it marks the page as having stasharr:
 * Stashboard then offers download buttons that link to StashDB scenes with
 * AUTO_SEARCH_HASH. Nothing else is read from or done to the page.
 */
(async function () {
  const { stashUrl } = await browser.storage.local.get({ stashUrl: "" });
  let origin;
  try {
    origin = new URL(String(stashUrl).trim()).origin;
  } catch (e) {
    return;
  }
  if (location.origin !== origin) return;
  document.documentElement.setAttribute("data-stasharr", browser.runtime.getManifest().version);
  window.dispatchEvent(new CustomEvent("stasharr:ready"));
})();
