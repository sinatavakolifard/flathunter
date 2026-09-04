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
        var counter = document.getElementById("seen-count");
        if (counter) {
          setCount("seen-count", parseInt(counter.textContent, 10) + 1);
        }
        post("/mark_seen", id).catch(function () {
          // Revert so the page never shows a state that was not stored
          card.classList.remove("seen");
          if (counter) {
            setCount("seen-count", parseInt(counter.textContent, 10) - 1);
          }
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

  // Show the last check as a relative time, refreshed in place
  var lastRun = document.getElementById("last-run");
  if (lastRun && lastRun.dataset.ts) {
    var when = new Date(lastRun.dataset.ts);
    var render = function () {
      var secs = Math.round((Date.now() - when.getTime()) / 1000);
      var text;
      if (secs < 60) { text = "just now"; }
      else if (secs < 3600) { text = Math.floor(secs / 60) + " min ago"; }
      else if (secs < 86400) { text = Math.floor(secs / 3600) + " h ago"; }
      else { text = Math.floor(secs / 86400) + " d ago"; }
      lastRun.textContent = text;
      lastRun.title = when.toLocaleString();
    };
    render();
    setInterval(render, 30000);
  }
})();
