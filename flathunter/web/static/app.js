// Listing interactions: marking seen on open, starring, the Wunschliste,
// and relative last-run time.

(function () {
  "use strict";

  function post(path, id) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id }),
      keepalive: true
    }).then(function (res) {
      if (!res.ok) { throw new Error("HTTP " + res.status); }
      return res.json();
    });
  }

  function setCount(elementId, value) {
    var el = document.getElementById(elementId);
    if (el) { el.textContent = value; }
  }

  document.querySelectorAll(".expose-card").forEach(function (card) {
    var id = card.dataset.exposeId;

    // Opening a listing marks it as seen. The click still follows the link.
    var link = card.querySelector("a.expose");
    if (link) {
      link.addEventListener("click", function () {
        if (card.classList.contains("seen")) { return; }
        card.classList.add("seen");
        post("/mark_seen", id).then(function (data) {
          setCount("seen-count", data.seen_total);
        }).catch(function () {
          // Revert so the page never shows a state that was not stored
          card.classList.remove("seen");
        });
      });
    }

    // The "Seen" badge is a button: clicking it marks the flat unseen again
    var seenBtn = card.querySelector(".seen-btn");
    if (seenBtn) {
      seenBtn.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (seenBtn.disabled || !card.classList.contains("seen")) { return; }
        seenBtn.disabled = true;
        card.classList.remove("seen");
        post("/unmark_seen", id).then(function (data) {
          setCount("seen-count", data.seen_total);
        }).catch(function () {
          card.classList.add("seen");
        }).finally(function () {
          seenBtn.disabled = false;
        });
      });
    }

    // The star and the heart behave identically apart from which list they
    // write to, so they share one handler.
    [
      {
        selector: ".star-btn", path: "/toggle_star", cls: "starred",
        field: "starred", totalField: "starred_total", countId: "starred-count",
        view: "starred", onTitle: "Remove star", offTitle: "Star this listing"
      },
      {
        selector: ".love-btn", path: "/toggle_loved", cls: "loved",
        field: "loved", totalField: "loved_total", countId: "loved-count",
        view: "wunschliste", onTitle: "Remove from Wunschliste",
        offTitle: "Add to Wunschliste"
      }
    ].forEach(function (spec) {
      var button = card.querySelector(spec.selector);
      if (!button) { return; }
      button.addEventListener("click", function (event) {
        // The button sits over the card; don't let the click open the listing
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) { return; }
        button.disabled = true;

        var wasOn = card.classList.contains(spec.cls);
        card.classList.toggle(spec.cls);
        button.setAttribute("aria-pressed", String(!wasOn));

        post(spec.path, id).then(function (data) {
          var isOn = data[spec.field];
          card.classList.toggle(spec.cls, isOn);
          button.setAttribute("aria-pressed", String(isOn));
          button.title = isOn ? spec.onTitle : spec.offTitle;
          setCount(spec.countId, data[spec.totalField]);
          // On that list's own page, a card just removed no longer belongs
          if (!isOn && document.body.dataset.view === spec.view) {
            card.classList.add("removing");
            setTimeout(function () { card.remove(); }, 220);
          }
        }).catch(function () {
          card.classList.toggle(spec.cls, wasOn);
          button.setAttribute("aria-pressed", String(wasOn));
        }).finally(function () {
          button.disabled = false;
        });
      });
    });
  });

  // "found ..." on each card, as a relative time
  function relative(secs) {
    if (secs < 60) { return "just now"; }
    if (secs < 3600) { return Math.floor(secs / 60) + " min ago"; }
    if (secs < 86400) { return Math.floor(secs / 3600) + " h ago"; }
    return Math.floor(secs / 86400) + " d ago";
  }

  document.querySelectorAll(".found[data-ts]").forEach(function (el) {
    // SQLite stores "YYYY-MM-DD HH:MM:SS.ffffff" with no zone; it is local time
    var when = new Date(el.dataset.ts.replace(" ", "T"));
    if (isNaN(when.getTime())) { return; }
    el.textContent = "found " + relative(Math.round((Date.now() - when.getTime()) / 1000));
    el.title = "First seen " + when.toLocaleString();
  });

  // Show the last check as a relative time, refreshed in place
  var lastRun = document.getElementById("last-run");
  if (lastRun && lastRun.dataset.ts) {
    var when = new Date(lastRun.dataset.ts);
    var render = function () {
      lastRun.textContent = relative(Math.round((Date.now() - when.getTime()) / 1000));
      lastRun.title = when.toLocaleString();
    };
    render();
    setInterval(render, 30000);
  }
})();
