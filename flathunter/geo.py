"""Place listings on a map

Every portal writes addresses differently, and many listings only name the
district. `location_for` reads an address into a street query and/or a
district, `Geocoder` turns those into coordinates through OpenStreetMap's
Nominatim, and `GeocodeWorker` does that in the background so the map page
never waits on the network. Results are cached in the database, keyed by
`exact_key` / `area_key`.
"""
import re
import threading
import time
import json

import requests

from flathunter.logging import logger

NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
USER_AGENT = 'wohnungssuche-local/1.0 (personal flat-hunting dashboard)'

# Nominatim results that describe an area rather than a street or a building
AREA_TYPES = {'suburb', 'city_district', 'quarter', 'neighbourhood', 'borough',
              'village', 'town', 'city', 'hamlet', 'municipality'}

PLZ = r'\d{5}'
INCOMPLETE = re.compile(r'\s*\(unvollständige Adresse\)\s*$')
WG_LINK = re.compile(r'wohnungen-in-([A-Za-z-]+)\.\d+\.html')


def city_for_plz(plz):
    """The city for the postcodes these searches actually return"""
    if not plz:
        return None
    number = int(plz)
    if 40210 <= number <= 40629:
        return 'Düsseldorf'
    if 47051 <= number <= 47279:
        return 'Duisburg'
    return None


def _restore_umlauts(name):
    """WG-Gesucht links spell Mörsenbroich as Moersenbroich"""
    name = re.sub(r'(?<![aeiouAEIOU])ae', 'ä', name)
    name = re.sub(r'(?<![aeiouAEIOU])oe', 'ö', name)
    name = re.sub(r'(?<![aeiouAEIOUq])ue', 'ü', name)
    return name.replace('Ae', 'Ä').replace('Oe', 'Ö').replace('Ue', 'Ü')


def _normalise_street(street):
    """Spell out the abbreviations Nominatim does not always recognise"""
    street = re.sub(r'(?i)str\.(?=\s|$)', 'straße', street)
    street = re.sub(r'(?i)strasse\b', 'straße', street)
    street = re.sub(r'(?i)(?<=[a-zäöü])str(?=\s+\d|\s*$)', 'straße', street)
    return re.sub(r'\s+', ' ', street).strip(' ,')


def _location(street, plz, city, district):
    """Build the location dict, dropping parts that carry no information"""
    district = (district or '').strip(' ,') or None
    # The postcode beats the typed city ("Düsselorf", "Düsseldorf / Benrath")
    city = city_for_plz(plz) \
        or re.split(r'\s+[/-]\s+|-(?=[A-ZÄÖÜ])', (city or '').strip(' ,'))[0] or None
    street = (street or '').strip(' ,')
    if street and city and street.endswith(city):
        # WG-Gesucht sometimes repeats the city after the street
        street = street[:-len(city)].strip(' ,')
    exact_query = None
    if street and street != district:
        exact_query = ', '.join(part for part in
                                (_normalise_street(street), ' '.join(
                                    p for p in (plz, city) if p)) if part)
    if exact_query is None and district is None:
        return None
    return {'exact_query': exact_query, 'district': district,
            'city': city, 'plz': plz}


def location_for(expose):
    """Read where a listing is from its address (or its link)

    Returns a dict with `exact_query` (a street address to look up, or None)
    and `district`/`city`/`plz` (the area it is in, district may be None),
    or None when the listing gives no usable location.
    """
    address = (expose.get('address') or '').strip()

    # WG-Gesucht without a looked-up address: the link names the district
    if not address or address.startswith('http'):
        match = WG_LINK.search(address or expose.get('url') or '')
        if not match or expose.get('crawler') not in (None, 'WgGesucht'):
            return None
        city, _, district = match.group(1).partition('-')
        if not district:
            return None
        return _location(None, None, _restore_umlauts(city),
                         _restore_umlauts(district.replace('-', ' ')))

    address = INCOMPLETE.sub('', address)

    # Immowelt: "Street 1, District, Stadtbezirk 6 (40470)"
    match = re.match(rf'^(.*)\(({PLZ})\)$', address)
    if match:
        parts = [p.strip() for p in match.group(1).split(',') if p.strip()]
        plz = match.group(2)
        if not parts:
            return None
        region = parts[-1]
        city = city_for_plz(plz)
        if city is None and not region.startswith('Stadtbezirk'):
            city = region
        rest = parts[:-1]
        if not rest:
            return _location(None, plz, city, region)
        district = rest[-1]
        street = ', '.join(rest[:-1])
        return _location(street, plz, city, district)

    # ImmoScout: "Street 1, 40589 Düsseldorf, Holthausen"
    parts = [p.strip() for p in address.split(',')]
    for index, part in enumerate(parts):
        match = re.match(rf'^({PLZ})\s+(.+)$', part)
        if match and len(parts) > 1:
            return _location(', '.join(parts[:index]), match.group(1),
                             match.group(2), ', '.join(parts[index + 1:]))

    # Kleinanzeigen: "40599 Benrath"
    match = re.match(rf'^({PLZ})\s+(.+)$', address)
    if match:
        return _location(None, match.group(1), None, match.group(2))

    # WG-Gesucht: "Benzenbergstr 4 40219 Düsseldorf Unterbilk"
    match = re.match(rf'^(.*?)\s*\b({PLZ})\s+(\S+)\s*(.*)$', address)
    if match:
        return _location(match.group(1), match.group(2), match.group(3),
                         match.group(4))

    return None


def exact_key(location):
    """Cache key for the street-level lookup, or None"""
    if not location or not location.get('exact_query'):
        return None
    return 'exact:' + location['exact_query']


def area_key(location):
    """Cache key for the district lookup, or None"""
    if not location or not location.get('district'):
        return None
    return f"area:{location['district']}|{location.get('city') or location.get('plz') or ''}"


def area_query(location):
    """Free-text Nominatim query for a district"""
    district = location['district']
    place = location.get('city') or location.get('plz')
    # Immowelt lists small towns as "Mettmann, Mettmann"
    if not place or place == district:
        return district
    return f'{district}, {place}'


class GeocodeError(Exception):
    """The lookup service could not be reached; try again later"""


class Geocoder:
    """Nominatim client, kept to one request per second as its rules ask"""

    def __init__(self, min_interval=1.1, session=None):
        self.min_interval = min_interval
        self.session = session or requests.Session()
        self.session.headers['User-Agent'] = USER_AGENT
        self._last_request = 0.0
        self._lock = threading.Lock()

    def _search(self, params):
        with self._lock:
            wait = self._last_request + self.min_interval - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            try:
                response = self.session.get(
                    NOMINATIM_URL, timeout=20,
                    params={'format': 'jsonv2', 'countrycodes': 'de', **params})
            except requests.RequestException as error:
                raise GeocodeError(str(error)) from error
            finally:
                self._last_request = time.monotonic()
        if response.status_code != 200:
            raise GeocodeError(f'HTTP {response.status_code}')
        return response.json()

    def lookup_exact(self, query):
        """(lat, lon, None) for a street address, or None if not found"""
        results = self._search({'q': query, 'limit': 1})
        if not results:
            return None
        return float(results[0]['lat']), float(results[0]['lon']), None

    def lookup_area(self, query):
        """(lat, lon, geojson) for a district, or None if not found

        The border is simplified so a page with dozens of districts stays
        light. Only areas are accepted, so "Bilk" does not land on a street
        called Bilker Allee.
        """
        results = self._search({'q': query, 'limit': 5, 'polygon_geojson': 1,
                                'polygon_threshold': 0.0003})
        for result in results:
            if result.get('addresstype') not in AREA_TYPES \
                    and result.get('type') not in AREA_TYPES:
                continue
            shape = result.get('geojson') or {}
            geojson = json.dumps(shape) \
                if shape.get('type') in ('Polygon', 'MultiPolygon') else None
            return float(result['lat']), float(result['lon']), geojson
        return None


def needed_lookups(exposes, cache):
    """Cache keys still to be looked up, in the order of the listings given

    The street lookup comes first; the district is only needed when there is
    no street, or the street could not be found.
    """
    todo = {}
    for expose in exposes:
        location = location_for(expose)
        if location is None:
            continue
        exact = exact_key(location)
        area = area_key(location)
        if exact and exact not in cache:
            todo.setdefault(exact, location)
            continue
        if exact and cache[exact][0] is not None:
            continue
        if area and area not in cache:
            todo.setdefault(area, location)
    return list(todo.items())


def resolve(expose, cache):
    """Where a listing goes on the map, using only cached lookups

    Returns ('exact', key, entry), ('area', key, entry), ('pending', None,
    None) if a lookup is still to come, or ('none', None, None).
    """
    location = location_for(expose)
    if location is None:
        return 'none', None, None
    for kind, key in (('exact', exact_key(location)), ('area', area_key(location))):
        if key is None:
            continue
        entry = cache.get(key)
        if entry is None:
            return 'pending', None, None
        if entry[0] is not None:
            return kind, key, entry
    return 'none', None, None


class GeocodeWorker(threading.Thread):
    """Looks up listing locations in the background of the web server"""

    def __init__(self, id_watch, filter_set=None, geocoder=None, idle_seconds=300):
        super().__init__(name='geocoder', daemon=True)
        self.id_watch = id_watch
        self.filter_set = filter_set
        self.geocoder = geocoder or Geocoder()
        self.idle_seconds = idle_seconds

    def run_once(self):
        """Look up everything missing. Returns how many lookups were made"""
        exposes, _ = self.id_watch.get_exposes_page(0, 10 ** 9)
        if self.filter_set is not None:
            # Listings the site shows by default go first
            exposes.sort(key=lambda e: not self.filter_set.is_interesting_expose(e))
        todo = needed_lookups(exposes, self.id_watch.get_geocodes())
        if todo:
            logger.info('Looking up map locations for %d addresses', len(todo))
        done = 0
        for key, location in todo:
            if key.startswith('exact:'):
                result = self.geocoder.lookup_exact(location['exact_query'])
            else:
                result = self.geocoder.lookup_area(area_query(location))
            lat, lon, geojson = result if result else (None, None, None)
            self.id_watch.save_geocode(key, lat, lon, geojson)
            done += 1
        return done

    def run(self):
        while True:
            try:
                # A street that was not found adds a district lookup, so
                # keep going until a pass finds nothing new
                if self.run_once():
                    continue
            except GeocodeError as error:
                logger.warning('Map location lookup failed, retrying later: %s', error)
            except Exception:  # pylint: disable=broad-except
                logger.exception('Map location lookup crashed, retrying later')
            time.sleep(self.idle_seconds)
