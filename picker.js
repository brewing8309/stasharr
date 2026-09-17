/*
 * Injected on demand (via browser.tabs.executeScript from background.js)
 * when the user right-clicks a text selection and picks "Search StashDB for
 * ...". Renders a floating panel listing the StashDB scenes that matched.
 *
 * This is purely a finder/confirmation UI — it does not talk to Prowlarr at
 * all. Picking a result just opens the real scene page on stashdb.org,
 * where the existing "⬇ Search Prowlarr" button takes over from there.
 *
 * Guarded against running its setup twice: a second right-click search on
 * the same tab re-injects this file, but content scripts injected via
 * executeScript share one global object per frame across repeat
 * injections in Firefox, so the guard below just lets the already-
 * registered message listener (and closePicker/renderPicker) handle it.
 */
(function () {
  if (window.__sdpPickerReady) return;
  window.__sdpPickerReady = true;

  function closePicker() {
    const p = document.getElementById("sdp-picker-panel");
    if (p) p.remove();
  }

  function fmtDate(d) {
    const m = String(d || "").match(/(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
  }

  function buildCandidateRow(scene) {
    const row = document.createElement("a");
    row.className = "sdp-row sdp-picker-row";
    row.href = `https://stashdb.org/scenes/${scene.id}`;
    row.target = "_blank";
    row.rel = "noopener noreferrer";

    const img = document.createElement("img");
    img.className = "sdp-thumb";
    img.alt = "";
    if (scene.image) {
      img.src = scene.image;
    } else {
      img.style.visibility = "hidden";
    }

    const info = document.createElement("div");
    info.className = "sdp-info";
    info.innerHTML = `<div class="sdp-rel-title"></div><div class="sdp-rel-meta"></div>`;
    info.querySelector(".sdp-rel-title").textContent = scene.title || "(untitled scene)";

    const bits = [];
    if (scene.studio) bits.push(scene.studio);
    const date = fmtDate(scene.date);
    if (date) bits.push(date);
    if (scene.performers && scene.performers.length) bits.push(scene.performers.join(", "));
    info.querySelector(".sdp-rel-meta").textContent = bits.join(" · ");

    row.appendChild(img);
    row.appendChild(info);
    return row;
  }

  function renderPicker(data) {
    closePicker();
    const panel = document.createElement("div");
    panel.id = "sdp-picker-panel";
    panel.innerHTML = `
      <div class="sdp-panel-head">
        <span class="sdp-title">StashDB search</span>
        <button type="button" class="sdp-close" title="Close">✕</button>
      </div>
      <div class="sdp-body"></div>`;
    panel.querySelector(".sdp-close").addEventListener("click", closePicker);
    document.body.appendChild(panel);

    const body = panel.querySelector(".sdp-body");
    const shownTerm = data.term || data.raw || "";
    const note = document.createElement("div");
    note.className = "sdp-note";
    note.textContent = data.term && data.raw && data.term !== data.raw
      ? `Searched for: "${data.term}" (selected: "${data.raw}")`
      : `Searched for: "${shownTerm}"`;
    body.appendChild(note);

    if (data.error) {
      const err = document.createElement("div");
      err.className = "sdp-empty";
      err.textContent = data.error;
      body.appendChild(err);
    } else if (!data.matches || !data.matches.length) {
      body.insertAdjacentHTML("beforeend", `<div class="sdp-empty">No matching StashDB scene found.</div>`);
    } else {
      for (const scene of data.matches) {
        body.appendChild(buildCandidateRow(scene));
      }
    }
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "sdpShowCandidates") renderPicker(msg);
  });
})();
