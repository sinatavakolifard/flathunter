import pytest

from flathunter import geo
from flathunter.idmaintainer import IdMaintainer


@pytest.mark.parametrize('crawler,address,exact,district,city', [
    ('Immobilienscout', 'Bonnerstr. 18b, 40589 Düsseldorf, Holthausen',
     'Bonnerstraße 18b, 40589 Düsseldorf', 'Holthausen', 'Düsseldorf'),
    ('Immobilienscout', '40215 Düsseldorf, Friedrichstadt (unvollständige Adresse)',
     None, 'Friedrichstadt', 'Düsseldorf'),
    ('Immowelt', 'Gatherweg 131, Lierenfeld, Stadtbezirk 8 (40231)',
     'Gatherweg 131, 40231 Düsseldorf', 'Lierenfeld', 'Düsseldorf'),
    ('Immowelt', 'Lörick, Stadtbezirk 4 (40547)', None, 'Lörick', 'Düsseldorf'),
    ('Immowelt', 'Lüderitzallee 55, Buchholz, Duisburg-Süd (47249)',
     'Lüderitzallee 55, 47249 Duisburg', 'Buchholz', 'Duisburg'),
    ('Immowelt', 'Friedenauer Straße 11, Monheim, Monheim am Rhein (40789)',
     'Friedenauer Straße 11, 40789 Monheim am Rhein', 'Monheim', 'Monheim am Rhein'),
    ('Kleinanzeigen', '40599 Benrath', None, 'Benrath', 'Düsseldorf'),
    ('Kleinanzeigen', '40233 Flingern Süd', None, 'Flingern Süd', 'Düsseldorf'),
    ('WgGesucht', 'Benzenbergstr 4 40219 Düsseldorf Unterbilk',
     'Benzenbergstraße 4, 40219 Düsseldorf', 'Unterbilk', 'Düsseldorf'),
    ('WgGesucht', 'Eintrachtstraße Düsseldorf 40227 Düsseldorf Oberbilk',
     'Eintrachtstraße, 40227 Düsseldorf', 'Oberbilk', 'Düsseldorf'),
    ('WgGesucht', 'https://www.wg-gesucht.de/wohnungen-in-Duesseldorf-Moersenbroich.14042654.html',
     None, 'Mörsenbroich', 'Düsseldorf'),
    ('WgGesucht', 'https://www.wg-gesucht.de/wohnungen-in-Duesseldorf-Flingern-Nord.13521560.html',
     None, 'Flingern Nord', 'Düsseldorf'),
])
def test_location_for_portal_addresses(crawler, address, exact, district, city):
    location = geo.location_for({'crawler': crawler, 'address': address})
    assert location['exact_query'] == exact
    assert location['district'] == district
    assert location['city'] == city


@pytest.mark.parametrize('address', [
    '', None, 'https://www.wg-gesucht.de/wohnungen-in-Duesseldorf.30.2.1.0.html',
    'Meineckestr. 52, 4474 Düsseldorf, Golzheim',
])
def test_location_for_unusable_addresses(address):
    assert geo.location_for({'crawler': 'WgGesucht', 'address': address}) is None


def test_area_query_skips_repeated_town():
    location = geo.location_for({'address': 'Mettmann, Mettmann (40822)'})
    assert geo.area_query(location) == 'Mettmann'


def test_resolve_prefers_street_and_falls_back_to_district():
    street = {'address': 'Bonnerstr. 18b, 40589 Düsseldorf, Holthausen'}
    location = geo.location_for(street)
    exact, area = geo.exact_key(location), geo.area_key(location)

    assert geo.resolve(street, {})[0] == 'pending'
    assert geo.needed_lookups([street], {}) == [(exact, location)]

    found = {exact: (51.17, 6.83, None)}
    assert geo.resolve(street, found) == ('exact', exact, (51.17, 6.83, None))
    assert geo.needed_lookups([street], found) == []

    # The street was not found: the district is looked up instead
    missing = {exact: (None, None, None)}
    assert geo.needed_lookups([street], missing) == [(area, location)]
    missing[area] = (51.18, 6.84, '{"type": "Polygon"}')
    assert geo.resolve(street, missing)[0] == 'area'

    missing[area] = (None, None, None)
    assert geo.resolve(street, missing)[0] == 'none'


class FakeGeocoder:
    def __init__(self):
        self.calls = []

    def lookup_exact(self, query):
        self.calls.append(query)
        return (51.0, 6.0, None)

    def lookup_area(self, query):
        self.calls.append(query)
        return (51.1, 6.1, '{"type": "Polygon", "coordinates": []}')


def test_worker_fills_cache():
    id_watch = IdMaintainer(':memory:')
    id_watch.save_expose({'id': 1, 'crawler': 'Kleinanzeigen', 'address': '40599 Benrath'})
    id_watch.save_expose({'id': 2, 'crawler': 'Kleinanzeigen', 'address': '40599 Benrath'})
    id_watch.save_expose({'id': 3, 'crawler': 'Immobilienscout',
                          'address': 'Bonnerstr. 18b, 40589 Düsseldorf, Holthausen'})
    geocoder = FakeGeocoder()
    worker = geo.GeocodeWorker(id_watch, geocoder=geocoder)

    assert worker.run_once() == 2
    assert sorted(geocoder.calls) == ['Benrath, Düsseldorf', 'Bonnerstraße 18b, 40589 Düsseldorf']
    assert id_watch.get_geocodes()['area:Benrath|Düsseldorf'][0] == 51.1
    assert worker.run_once() == 0


@pytest.mark.parametrize('address,city', [
    ('Hauptstr. 5, 40597 Düsseldorf / Benrath, Benrath', 'Düsseldorf'),
    ('Kölner Str. 1, 40211 Düsselorf, Stadtmitte', 'Düsseldorf'),
    ('Hauptstr. 5, 40764 Langenfeld (Rheinland), Mitte', 'Langenfeld (Rheinland)'),
    ('Markt 1, 41460 Neuss-Innenstadt, Innenstadt', 'Neuss'),
])
def test_location_for_cleans_city(address, city):
    assert geo.location_for({'address': address})['city'] == city
