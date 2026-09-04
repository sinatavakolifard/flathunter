// Listing interactions: marking seen on open, starring, relative last-run time.

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

    var star = card.querySelector(".star-btn");
    if (!star) { return; }
    star.addEventListener("click", function (event) {
      // The button sits over the card; don't let the click open the listing
      event.preventDefault();
      event.stopPropagation();
      if (star.disabled) { return; }
      star.disabled = true;

      var wasStarred = card.classList.contains("starred");
      card.classList.toggle("starred");
      star.setAttribute("aria-pressed", String(!wasStarred));

      post("/toggle_star", id).then(function (data) {
        card.classList.toggle("starred", data.starred);
        star.setAttribute("aria-pressed", String(data.starred));
        star.title = data.starred ? "Remove star" : "Star this listing";
        setCount("starred-count", data.starred_total);
        // On the starred page, an unstarred card no longer belongs here
        if (!data.starred && document.body.dataset.view === "starred") {
          card.classList.add("removing");
          setTimeout(function () { card.remove(); }, 220);
        }
      }).catch(function () {
        card.classList.toggle("starred", wasStarred);
        star.setAttribute("aria-pressed", String(wasStarred));
      }).finally(function () {
        star.disabled = false;
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
