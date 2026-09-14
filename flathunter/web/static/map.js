// Map page: listings with a street address as pins, listings that only name
// their district as shaded district borders, and a side list of whatever is
// inside the current view.

(function () {
  "use strict";

  var mapEl = document.getElementById("map");
  if (!mapEl || !window.L) { return; }
  var W = window.Wohnungssuche || { bindCard: function () {}, relative: null };

  var DUESSELDORF = { lat: 51.2277, lng: 6.7735, zoom: 12 };
  var VIEW_KEY = "wohnungssuche.map-view";
  var AREA_STYLE = {
    color: "#e8590c", weight: 1.5, dashArray: "5 4",
    fillColor: "#fd7e14", fillOpacity: 0.14
  };
  var AREA_HOVER = { weight: 3, fillOpacity: 0.32 };
  var MAX_CARDS = 150;
  // Below this zoom the district name labels would pile on top of each other
  var LABEL_ZOOM = 12;

  var listEl = document.getElementById("map-list");
  var countEl = document.getElementById("in-view-count");
  var hiddenEl = document.getElementById("hidden-note");
  var statusEl = document.getElementById("map-status");
  var source = mapEl.dataset.source;

  // ---------- helpers ----------

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Same display rules as templates/exposes.html
  function formatPrice(price) {
    if (price == null || price === "") { return ""; }
    price = String(price).replace("€Kalt", "€ Kalt").replace("€Warm", "€ Warm");
    return price.indexOf("€") >= 0 ? price : price + " €";
  }

  function formatRooms(rooms) {
    rooms = String(rooms == null ? "" : rooms).trim();
    if (!rooms) { return ""; }
    return rooms.indexOf("immer") >= 0 || rooms.indexOf("Zi") >= 0 ? rooms : rooms + " Zi.";
  }

  function newestFirst(a, b) {
    return String(b.created_at || "").localeCompare(String(a.created_at || ""));
  }

  function loadView() {
    try {
      var view = JSON.parse(localStorage.getItem(VIEW_KEY));
      if (view && isFinite(view.lat) && isFinite(view.lng) && isFinite(view.zoom)) {
        return view;
      }
    } catch (e) { /* no storage, use the default */ }
    return null;
  }

  function saveView() {
    var center = map.getCenter();
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(
        { lat: center.lat, lng: center.lng, zoom: map.getZoom() }));
    } catch (e) { /* not important */ }
  }

  // ---------- map ----------

  var savedView = loadView();
  var start = savedView || DUESSELDORF;
  // The list shows what is in the map's bounds, so the map must end at the
  // bottom of the window - otherwise it counts listings scrolled out of sight
  var sideEl = document.querySelector(".map-side");
  function fitToWindow() {
    if (!window.matchMedia("(min-width: 900px)").matches) {
      mapEl.style.height = sideEl.style.height = "";
      return;
    }
    var top = mapEl.getBoundingClientRect().top + window.scrollY;
    var legend = mapEl.nextElementSibling ? mapEl.nextElementSibling.offsetHeight + 8 : 0;
    var height = Math.max(420, window.innerHeight - top - legend - 20) + "px";
    mapEl.style.height = height;
    sideEl.style.height = "calc(" + height + " + " + legend + "px)";
  }
  fitToWindow();

  var map = L.map(mapEl).setView([start.lat, start.lng], start.zoom);
  window.addEventListener("resize", function () {
    fitToWindow();
    map.invalidateSize();
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  var areaLayer = L.layerGroup().addTo(map);
  var labelLayer = L.layerGroup().addTo(map);
  var pinLayer = L.layerGroup().addTo(map);

  // Each point is one address (several listings can share a building) and
  // each area one district; `owners` maps a listing id to its point or area.
  var points = [];
  var areas = [];
  var owners = {};
  var lastPayload = null;

  function pinIcon(point) {
    var listings = point.listings;
    var classes = ["pin"];
    if (listings.every(function (l) { return l.seen; })) { classes.push("seen"); }
    if (listings.some(function (l) { return l.starred; })) { classes.push("starred"); }
    if (listings.some(function (l) { return l.loved; })) { classes.push("loved"); }
    var size = listings.length > 1 ? 24 : 16;
    return L.divIcon({
      className: "pin-wrap",
      html: '<span class="' + classes.join(" ") + '">' +
            (listings.length > 1 ? listings.length : "") + "</span>",
      iconSize: [size, size]
    });
  }

  function popupHtml(title, listings) {
    var shown = listings.slice(0, 12);
    var rows = shown.map(function (l) {
      var facts = [formatPrice(l.price), l.size, formatRooms(l.rooms)]
        .filter(Boolean).map(escapeHtml).join(" · ");
      return '<li><a href="' + escapeHtml(l.url) + '" target="_blank" rel="noreferrer noopener">' +
             escapeHtml(l.title) + "</a><span>" + facts + "</span></li>";
    }).join("");
    var more = listings.length > shown.length
      ? '<p class="popup-more">+ ' + (listings.length - shown.length) + " more in the list</p>" : "";
    return '<div class="map-popup">' + (title ? "<strong>" + escapeHtml(title) + "</strong>" : "") +
           "<ul>" + rows + "</ul>" + more + "</div>";
  }

  function draw(data) {
    areaLayer.clearLayers();
    labelLayer.clearLayers();
    pinLayer.clearLayers();
    points = [];
    areas = [];
    owners = {};

    var byPosition = {};
    data.exact.forEach(function (listing) {
      var key = listing.lat.toFixed(5) + "," + listing.lon.toFixed(5);
      if (!byPosition[key]) {
        byPosition[key] = { kind: "point", lat: listing.lat, lon: listing.lon, listings: [] };
        points.push(byPosition[key]);
      }
      byPosition[key].listings.push(listing);
    });

    points.forEach(function (point) {
      point.listings.sort(newestFirst);
      var title = point.listings.length === 1
        ? point.listings[0].address : point.listings[0].address + " · " + point.listings.length + " listings";
      point.marker = L.marker([point.lat, point.lon], { icon: pinIcon(point), riseOnHover: true })
        .bindPopup(popupHtml(title, point.listings), { maxWidth: 300 })
        .on("click", function () { revealInList(point); })
        .addTo(pinLayer);
      point.listings.forEach(function (l) { owners[l.id] = point; });
    });

    data.areas.forEach(function (area) {
      area.kind = "area";
      area.listings.sort(newestFirst);
      if (area.geojson) {
        area.layer = L.geoJSON(area.geojson, { style: AREA_STYLE });
        area.bounds = area.layer.getBounds();
      } else {
        // No border known: a circle around the district centre. A circle
        // only knows its bounds once on the map, so work them out here.
        area.layer = L.circle([area.lat, area.lon], L.extend({ radius: 700 }, AREA_STYLE));
        area.bounds = L.latLng(area.lat, area.lon).toBounds(1400);
      }
      areas.push(area);
      area.listings.forEach(function (l) { owners[l.id] = area; });
    });
    // Bigger districts are added first, so small ones end up on top and stay clickable
    areas.sort(function (a, b) {
      return areaSize(b.bounds) - areaSize(a.bounds);
    }).forEach(function (area) {
      var title = area.district + " – only the district is known";
      area.layer.bindPopup(popupHtml(title, area.listings), { maxWidth: 300 })
        .on("click", function () { revealInList(area); })
        .addTo(areaLayer);
      L.marker([area.lat, area.lon], {
        interactive: false, keyboard: false,
        icon: L.divIcon({
          className: "area-label", iconSize: [0, 0],
          html: "<span>" + escapeHtml(area.district) + " · " + area.listings.length + "</span>"
        })
      }).addTo(labelLayer);
    });

    updateLabels();
  }

  // The outer rings of a district border as [lng, lat] lists
  function outerRings(geojson) {
    if (geojson.type === "Polygon") { return [geojson.coordinates[0]]; }
    return geojson.coordinates.map(function (polygon) { return polygon[0]; });
  }

  function insideRing(lng, lat, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Whether a district's actual shape reaches into the view. Its bounding
  // box alone is too generous for long, diagonal districts.
  function areaInView(area, view) {
    if (!view.intersects(area.bounds)) { return false; }
    if (!area.geojson) { return true; }
    var rings = outerRings(area.geojson);
    var corners = [view.getNorthWest(), view.getNorthEast(), view.getSouthWest(),
                   view.getSouthEast(), view.getCenter()];
    return rings.some(function (ring) {
      return ring.some(function (p) { return view.contains([p[1], p[0]]); }) ||
        corners.some(function (c) { return insideRing(c.lng, c.lat, ring); });
    });
  }

  function areaSize(bounds) {
    return (bounds.getNorth() - bounds.getSouth()) * (bounds.getEast() - bounds.getWest());
  }

  function updateLabels() {
    mapEl.classList.toggle("hide-area-labels", map.getZoom() < LABEL_ZOOM);
  }

  function highlight(owner, on) {
    if (!owner) { return; }
    if (owner.kind === "point") {
      var el = owner.marker.getElement();
      if (el) { el.classList.toggle("hover", on); }
      owner.marker.setZIndexOffset(on ? 1000 : 0);
    } else {
      owner.layer.setStyle(on ? AREA_HOVER : { weight: AREA_STYLE.weight, fillOpacity: AREA_STYLE.fillOpacity });
    }
  }

  // ---------- side list ----------

  function cardHtml(l) {
    var classes = ["expose-card"];
    if (l.seen) { classes.push("seen"); }
    if (l.starred) { classes.push("starred"); }
    if (l.loved) { classes.push("loved"); }
    var image = l.image || "/static/placeholder.png";
    var facts = [l.size, formatRooms(l.rooms), l.from ? "ab " + l.from : ""]
      .filter(Boolean).map(function (f) { return '<span class="fact">' + escapeHtml(f) + "</span>"; }).join("");
    return '<div class="' + classes.join(" ") + '" data-expose-id="' + escapeHtml(l.id) + '">' +
      '<div class="card-actions">' +
        '<button type="button" class="seen-btn" title="Mark as unseen">Seen</button>' +
        '<button type="button" class="love-btn" aria-pressed="' + !!l.loved + '" aria-label="Wunschliste"' +
          ' title="' + (l.loved ? "Remove from Wunschliste" : "Add to Wunschliste") + '">' +
          '<span class="love-on">♥</span><span class="love-off">♡</span></button>' +
        '<button type="button" class="star-btn" aria-pressed="' + !!l.starred + '" aria-label="Star"' +
          ' title="' + (l.starred ? "Remove star" : "Star this listing") + '">' +
          '<span class="star-on">★</span><span class="star-off">☆</span></button>' +
      "</div>" +
      '<a class="expose" href="' + escapeHtml(l.url) + '" rel="noreferrer noopener" target="_blank">' +
        '<div class="expose-media">' +
          '<img src="' + escapeHtml(image) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' +
          (l.crawler ? '<span class="source">' + escapeHtml(l.crawler) + "</span>" : "") +
          (l.price ? '<span class="price-tag">' + escapeHtml(formatPrice(l.price)) + "</span>" : "") +
        "</div>" +
        '<div class="expose-body">' +
          '<h3 class="expose-title">' + escapeHtml(l.title) + "</h3>" +
          (l.address ? '<div class="addr">' + escapeHtml(l.address) + "</div>" : "") +
          '<div class="facts">' + facts + "</div>" +
          (l.created_at ? '<div class="found" data-ts="' + escapeHtml(l.created_at) + '">found ' +
            escapeHtml(String(l.created_at).slice(0, 16)) + "</div>" : "") +
        "</div>" +
      "</a></div>";
  }

  function renderList() {
    var view = map.getBounds();
    var exactInView = [];
    points.forEach(function (point) {
      if (view.contains([point.lat, point.lon])) {
        exactInView = exactInView.concat(point.listings);
      }
    });
    exactInView.sort(newestFirst);
    var areasInView = areas.filter(function (area) { return areaInView(area, view); })
      .sort(function (a, b) { return b.listings.length - a.listings.length; });
    var areaCount = areasInView.reduce(function (n, a) { return n + a.listings.length; }, 0);

    countEl.textContent = (exactInView.length + areaCount) + " apartments in view";
    hiddenEl.textContent = exactInView.length + " with address, " + areaCount + " by district";

    var budget = MAX_CARDS;
    var html = "";
    function cards(listings) {
      var shown = listings.slice(0, Math.max(0, budget));
      budget -= shown.length;
      return '<div class="exposes">' + shown.map(cardHtml).join("") + "</div>";
    }

    if (exactInView.length) {
      html += '<h2 class="map-section">Exact address <span>' + exactInView.length + "</span></h2>";
      html += cards(exactInView);
    }
    if (areasInView.length) {
      html += '<h2 class="map-section area">Somewhere in these districts <span>' + areaCount + "</span></h2>";
      areasInView.forEach(function (area) {
        if (budget <= 0) { return; }
        html += '<h3 class="map-district" data-area="' + escapeHtml(area.key) + '">' +
                escapeHtml(area.district) + " <span>" + area.listings.length + "</span></h3>";
        html += cards(area.listings);
      });
    }
    if (exactInView.length + areaCount > MAX_CARDS) {
      html += '<p class="map-note">Showing the first ' + MAX_CARDS + ". Zoom in to see the rest.</p>";
    }
    if (!exactInView.length && !areasInView.length) {
      html = '<div class="empty"><strong>Nothing here</strong>Move or zoom out the map to find listings.</div>';
    }
    listEl.innerHTML = html;

    listEl.querySelectorAll(".expose-card").forEach(function (card) {
      var id = Number(card.dataset.exposeId);
      var owner = owners[id];
      card.addEventListener("mouseenter", function () { highlight(owner, true); });
      card.addEventListener("mouseleave", function () { highlight(owner, false); });
      W.bindCard(card, function (field, isOn) { updateListing(id, field, isOn); });
    });
    listEl.querySelectorAll(".map-district").forEach(function (heading) {
      var area = areas.filter(function (a) { return a.key === heading.dataset.area; })[0];
      heading.addEventListener("mouseenter", function () { highlight(area, true); });
      heading.addEventListener("mouseleave", function () { highlight(area, false); });
      heading.addEventListener("click", function () { map.fitBounds(area.bounds, { padding: [30, 30] }); });
    });
    if (W.relative) {
      listEl.querySelectorAll(".found[data-ts]").forEach(function (el) {
        var when = new Date(el.dataset.ts.replace(" ", "T"));
        if (isNaN(when.getTime())) { return; }
        el.textContent = "found " + W.relative(Math.round((Date.now() - when.getTime()) / 1000));
        el.title = "First seen " + when.toLocaleString();
      });
    }
  }

  // A star, heart or visit changes the pin as well as the card
  function updateListing(id, field, isOn) {
    var owner = owners[id];
    if (!owner) { return; }
    owner.listings.forEach(function (l) { if (l.id === id) { l[field] = isOn; } });
    if (owner.kind === "point") { owner.marker.setIcon(pinIcon(owner)); }
  }

  function revealInList(owner) {
    // Only when the list scrolls beside the map; on phones it sits below
    if (!window.matchMedia("(min-width: 900px)").matches) { return; }
    var card = listEl.querySelector('[data-expose-id="' + owner.listings[0].id + '"]');
    if (!card) { return; }
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    owner.listings.forEach(function (l) {
      var el = listEl.querySelector('[data-expose-id="' + l.id + '"]');
      if (!el) { return; }
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
    });
  }

  var renderTimer = null;
  map.on("moveend", function () {
    saveView();
    updateLabels();
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderList, 120);
  });

  // ---------- data ----------

  function showStatus(data) {
    var parts = [];
    if (data.pending) {
      parts.push("Still finding the position of " + data.pending +
                 " listings – the map fills in by itself.");
    }
    if (data.no_location) {
      parts.push(data.no_location + " listings have no usable address and are not shown.");
    }
    statusEl.textContent = parts.join(" ");
    setStatusVisible(parts.length > 0);
  }

  // Showing or hiding the status line moves the map, so refit its height
  function setStatusVisible(visible) {
    if (statusEl.hidden !== visible) { return; }
    statusEl.hidden = !visible;
    fitToWindow();
    map.invalidateSize();
  }

  function load(first) {
    fetch("/map/data" + (source ? "?source=" + encodeURIComponent(source) : ""))
      .then(function (res) {
        if (!res.ok) { throw new Error("HTTP " + res.status); }
        return res.text();
      })
      .then(function (text) {
        var data = JSON.parse(text);
        // Redrawing closes open popups, so only do it when something changed
        if (text !== lastPayload) {
          lastPayload = text;
          draw(data);
          if (first && !savedView) {
            var all = points.map(function (p) { return [p.lat, p.lon]; });
            areas.forEach(function (a) { all.push([a.lat, a.lon]); });
            if (all.length) { map.fitBounds(all, { padding: [30, 30], maxZoom: 14 }); }
          }
          renderList();
        }
        showStatus(data);
        if (data.pending) { setTimeout(load, 20000); }
      })
      .catch(function (error) {
        console.error("Map data", error);
        statusEl.textContent = "Could not load the listings. Is the web server still running?";
        setStatusVisible(true);
      });
  }

  load(true);
})();
