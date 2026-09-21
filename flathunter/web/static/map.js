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
  var FILTERS_KEY = "wohnungssuche.map-filters";
  var FIELDS = ["rooms", "price", "size"];
  // How far one nudge of a slider moves it
  var FILTER_STEPS = { rooms: 0.5, price: 50, size: 5 };
  var UNITS = { rooms: "", price: " €", size: " m²" };
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
  var filterBarEl = document.getElementById("map-filters");
  var filterCountEl = document.getElementById("filter-count");
  var filterResetEl = document.getElementById("filter-reset");
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

  // The values are written for people, not for machines: "2,5 Zimmer",
  // "1.300 €Kaltmiete", "48,8 m²". German numbers, so a dot separates
  // thousands and a comma the decimals. A few listings have a whole
  // sentence in the price field - those count as "not known".
  function parseNumber(value) {
    var text = String(value == null ? "" : value)
      .replace(/Kaltmiete|Warmmiete|Kalt|Warm|Miete|Zimmer|Zi\.?|EUR|€|m²|m2|qm/gi, "")
      .replace(/\s/g, "");
    if (!/^\d+([.,]\d+)*$/.test(text)) { return null; }
    // A lone dot with one or two digits behind it is a decimal point, not a
    // thousands separator: "48.8" is a size, "1.300" a price
    text = /^\d+\.\d{1,2}$/.test(text)
      ? text : text.replace(/\./g, "").replace(",", ".");
    var number = parseFloat(text);
    return isFinite(number) && number > 0 ? number : null;
  }

  function emptyFilters() {
    var empty = {};
    FIELDS.forEach(function (field) { empty[field] = { min: null, max: null }; });
    return empty;
  }

  function bound(value) {
    return isFinite(value) && value !== null ? Number(value) : null;
  }

  function loadFilters() {
    var loaded = emptyFilters();
    try {
      var saved = JSON.parse(localStorage.getItem(FILTERS_KEY)) || {};
      FIELDS.forEach(function (field) {
        if (saved[field]) {
          loaded[field] = { min: bound(saved[field].min), max: bound(saved[field].max) };
        }
      });
    } catch (e) { /* no storage, show everything */ }
    return loaded;
  }

  function saveFilters() {
    try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch (e) { /* not important */ }
  }

  function anyFilterSet() {
    return FIELDS.some(function (field) {
      return filters[field].min !== null || filters[field].max !== null;
    });
  }

  function formatNumber(field, value, bare) {
    var text = field === "rooms"
      ? String(value).replace(".", ",") : value.toLocaleString("de-DE");
    return bare ? text : text + UNITS[field];
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
  // After a size change the district borders and the list must follow the
  // new view; Leaflet only redraws them once the map has moved
  function resized() {
    fitToWindow();
    map.invalidateSize({ animate: false });
    map.fire("moveend");
  }
  window.addEventListener("resize", resized);

  // ---------- fullscreen ----------

  var EXPAND_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
    '<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  var SHRINK_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
    '<path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  // The map covers the whole browser window, not the screen, so the
  // browser's tabs and address bar stay visible
  var fullscreenButton = null;

  function isFullscreen() {
    return mapEl.classList.contains("map-fullscreen");
  }

  function setFullscreen(on) {
    mapEl.classList.toggle("map-fullscreen", on);
    document.body.classList.toggle("map-fullscreen-open", on);
    fullscreenButton.innerHTML = on ? SHRINK_ICON : EXPAND_ICON;
    fullscreenButton.title = on ? "Exit fullscreen (Esc)" : "Fullscreen";
    fullscreenButton.setAttribute("aria-pressed", String(on));
    resized();
  }

  function toggleFullscreen() {
    setFullscreen(!isFullscreen());
  }

  var FullscreenControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd: function () {
      var bar = L.DomUtil.create("div", "leaflet-bar");
      fullscreenButton = L.DomUtil.create("a", "map-fullscreen-btn", bar);
      fullscreenButton.href = "#";
      fullscreenButton.setAttribute("role", "button");
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.on(fullscreenButton, "click", function (event) {
        L.DomEvent.preventDefault(event);
        toggleFullscreen();
      });
      return bar;
    }
  });
  map.addControl(new FullscreenControl());
  setFullscreen(false);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && isFullscreen()) { setFullscreen(false); }
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
  var lastData = null;
  // The ranges picked in the filter bar; null ends are open
  var filters = loadFilters();

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
      html = anyFilterSet() && !points.length && !areas.length
        ? '<div class="empty"><strong>No matches</strong>No listings fit the filters. Widen them or press Reset.</div>'
        : '<div class="empty"><strong>Nothing here</strong>Move or zoom out the map to find listings.</div>';
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
    // Opening a popup can pan the map and redraw the list; keep the
    // selection, and scroll to it again if it was only just made
    markSelected(Date.now() - selectedAt < 1500);
  }

  // A star, heart or visit changes the pin as well as the card
  function updateListing(id, field, isOn) {
    var owner = owners[id];
    if (!owner) { return; }
    owner.listings.forEach(function (l) { if (l.id === id) { l[field] = isOn; } });
    if (owner.kind === "point") { owner.marker.setIcon(pinIcon(owner)); }
  }

  // The listings of the pin or district last clicked on the map. They stay
  // marked in the list until something else is picked or the popup closes.
  var selectedIds = {};
  var selectedAt = 0;

  function revealInList(owner) {
    selectedIds = {};
    owner.listings.forEach(function (l) { selectedIds[l.id] = true; });
    selectedAt = Date.now();
    markSelected(true);
  }

  function markSelected(scroll) {
    var first = null;
    listEl.querySelectorAll(".expose-card").forEach(function (card) {
      var on = !!selectedIds[card.dataset.exposeId];
      card.classList.toggle("selected", on);
      if (on && !first) { first = card; }
    });
    // Only scroll when the list sits beside the map; on phones it is below
    if (scroll && first && window.matchMedia("(min-width: 900px)").matches) {
      var side = listEl.closest(".map-side");
      var head = side.querySelector(".map-side-head");
      var offset = first.getBoundingClientRect().top - side.getBoundingClientRect().top -
                   head.offsetHeight - 8;
      // A long smooth scroll gets cut short, so jump when the card is far away
      side.scrollTo({ top: side.scrollTop + offset,
                      behavior: Math.abs(offset) < 1500 ? "smooth" : "auto" });
    }
  }

  map.on("popupclose", function () {
    selectedIds = {};
    markSelected(false);
  });

  var renderTimer = null;
  map.on("moveend", function () {
    saveView();
    updateLabels();
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderList, 120);
  });

  // ---------- filters ----------

  // A listing whose value is unknown drops out as soon as that field is
  // filtered - there is no way to tell whether it would fit
  function matchesFilters(listing) {
    return FIELDS.every(function (field) {
      var range = filters[field];
      if (range.min === null && range.max === null) { return true; }
      var value = parseNumber(listing[field]);
      return value !== null &&
        (range.min === null || value >= range.min) &&
        (range.max === null || value <= range.max);
    });
  }

  // A copy of the data with only the matching listings; districts left
  // without any listing are dropped
  function filtered(data) {
    return {
      exact: data.exact.filter(matchesFilters),
      areas: data.areas.map(function (area) {
        return L.extend({}, area, { listings: area.listings.filter(matchesFilters) });
      }).filter(function (area) { return area.listings.length; })
    };
  }

  function allListings(data) {
    var all = data.exact.slice();
    data.areas.forEach(function (area) { all = all.concat(area.listings); });
    return all;
  }

  // How far each slider can go: the listings' own smallest and largest
  // value, widened to a round step so the ends are readable numbers
  function sliderLimits(field, values) {
    var step = FILTER_STEPS[field];
    // Never start at zero: one listing priced at 1 € would otherwise waste
    // most of the track on prices nothing is listed at
    var lo = Math.max(step, Math.floor(Math.min.apply(null, values) / step) * step);
    var hi = Math.ceil(Math.max.apply(null, values) / step) * step;
    // One step of room either way, so a single-value field still has a track
    if (hi <= lo) { hi = lo + step; }
    return { lo: Math.round(lo * 10) / 10, hi: Math.round(hi * 10) / 10, step: step };
  }

  // The text beside a slider: both ends, one end, or nothing set
  function rangeText(field) {
    var range = filters[field];
    if (range.min === null && range.max === null) { return "any"; }
    if (range.max === null) { return "from " + formatNumber(field, range.min); }
    if (range.min === null) { return "up to " + formatNumber(field, range.max); }
    // The unit belongs at the end only: "600 – 1.200 €"
    return formatNumber(field, range.min, true) + " – " + formatNumber(field, range.max);
  }

  // What the handles are sitting on, with an open end resting at the limit
  function handleValues(field, limits) {
    var range = filters[field];
    return {
      min: range.min === null ? limits.lo : Math.min(Math.max(range.min, limits.lo), limits.hi),
      max: range.max === null ? limits.hi : Math.min(Math.max(range.max, limits.lo), limits.hi)
    };
  }

  var limitsByField = {};

  function renderFilterBar() {
    if (lastData) {
      var all = allListings(lastData);
      FIELDS.forEach(function (field) {
        var values = all.map(function (l) { return parseNumber(l[field]); })
          .filter(function (v) { return v !== null; });
        limitsByField[field] = values.length ? sliderLimits(field, values) : null;
      });
    }
    FIELDS.forEach(function (field) {
      var limits = limitsByField[field];
      var rangeEl = filterBarEl.querySelector('.range[data-field="' + field + '"]');
      var valueEl = filterBarEl.querySelector('.range-value[data-field="' + field + '"]');
      var inputs = rangeEl.querySelectorAll("input");
      var at = limits ? handleValues(field, limits) : { min: 0, max: 1 };
      inputs.forEach(function (input) {
        input.disabled = !limits;
        input.min = limits ? limits.lo : 0;
        input.max = limits ? limits.hi : 1;
        input.step = limits ? limits.step : 1;
        input.value = at[input.dataset.bound];
      });
      // The handle that can still move must sit on top where they meet
      var span = limits ? limits.hi - limits.lo : 1;
      var middle = limits ? limits.lo + span / 2 : 0;
      inputs[0].style.zIndex = at.min > middle ? 3 : 2;
      inputs[1].style.zIndex = at.min > middle ? 2 : 3;
      var fill = rangeEl.querySelector(".range-fill");
      fill.style.left = (limits ? (at.min - limits.lo) / span * 100 : 0) + "%";
      fill.style.right = (limits ? (limits.hi - at.max) / span * 100 : 0) + "%";
      var isSet = filters[field].min !== null || filters[field].max !== null;
      // Not "empty" - that class is the big dashed box of the empty list
      rangeEl.classList.toggle("range-open", !isSet);
      valueEl.classList.toggle("set", isSet);
      valueEl.textContent = limits ? rangeText(field) : "…";
    });
    filterResetEl.hidden = !anyFilterSet();
    if (lastData) {
      var listings = allListings(lastData);
      filterCountEl.textContent = anyFilterSet()
        ? listings.filter(matchesFilters).length + " of " + listings.length + " match"
        : listings.length + " listings";
    } else {
      filterCountEl.textContent = "";
    }
  }

  function applyFilters() {
    saveFilters();
    renderFilterBar();
    if (lastData) {
      // Redrawing removes the pin a popup may be attached to
      map.closePopup();
      draw(filtered(lastData));
      renderList();
    }
  }

  // While a handle is being dragged the bar keeps up with it; the map and
  // the list follow a moment later, so dragging stays smooth
  var dragTimer = null;

  filterBarEl.addEventListener("input", function (event) {
    var input = event.target.closest(".range input");
    if (!input) { return; }
    var field = input.dataset.field;
    var limits = limitsByField[field];
    if (!limits) { return; }
    var rangeEl = input.parentNode;
    var inputs = rangeEl.querySelectorAll("input");
    var low = Number(inputs[0].value);
    var high = Number(inputs[1].value);
    // The handles push against each other rather than swapping over
    if (low > high) {
      if (input.dataset.bound === "min") { low = high; } else { high = low; }
    }
    // A handle resting at its end of the track means "no limit here", so
    // listings with no value of their own are not thrown away
    filters[field] = {
      min: low <= limits.lo ? null : low,
      max: high >= limits.hi ? null : high
    };
    renderFilterBar();
    clearTimeout(dragTimer);
    dragTimer = setTimeout(applyFilters, 140);
  });

  filterResetEl.addEventListener("click", function () {
    filters = emptyFilters();
    applyFilters();
  });

  renderFilterBar();
  // The filter bar takes up room of its own, so the map moves down
  resized();

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
    resized();
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
          lastData = data;
          renderFilterBar();
          draw(filtered(data));
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
