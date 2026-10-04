import re

import pytest
from bs4 import BeautifulSoup

from flathunter.crawler.kleinanzeigen import Kleinanzeigen
from flathunter.geo import location_for
from test.utils.config import StringConfig

DUMMY_CONFIG = """
urls:
  - https://www.kleinanzeigen.de/s-wohnung-mieten/muenchen/anbieter:privat/anzeige:angebote/preis:600:1000
    """

TEST_URL = 'https://www.kleinanzeigen.de/s-wohnung-mieten/berlin/preis:1000:1500/c203l3331+wohnung_mieten.qm_d:70,+wohnung_mieten.zimmer_d:2'

@pytest.fixture
def crawler():
    return Kleinanzeigen(StringConfig(string=DUMMY_CONFIG))

def test_crawler(crawler):
    soup = crawler.get_page(TEST_URL)
    assert soup is not None
    entries = crawler.extract_data(soup)
    assert entries is not None
    assert len(entries) > 0
    assert entries[0]['id'] > 0
    assert entries[0]['url'].startswith("https://www.kleinanzeigen.de/s-anzeige")
    for attr in [ 'title', 'price', 'size', 'rooms', 'address' ]:
        assert entries[0][attr]

def test_process_expose_fetches_details(crawler):
    soup = crawler.get_page(TEST_URL)
    assert soup is not None
    entries = crawler.extract_data(soup)
    assert entries is not None
    assert len(entries) > 0
    updated_entries = [ crawler.get_expose_details(expose) for expose in entries ]
    for expose in updated_entries:
        print(expose)
        # Not every listing states its room count, but these are always there
        for attr in [ 'title', 'price', 'size', 'address' ]:
            assert expose[attr]
        # Most listings do not state an availability date, so `from` is only
        # there sometimes - but when it is, it is a date and not a label
        if expose.get('from'):
            assert re.match(r'^\d{2}\.\d{2}\.\d{4}$', expose['from'])
    # The search results only name a district; the listing pages carry the
    # street for a good share of them
    assert any(not re.match(r'^\d{5}\b', expose['address'])
               for expose in updated_entries)


def address_page(street, locality):
    """The address markup Kleinanzeigen puts at the top of a listing page"""
    street_span = ''
    if street:
        street_span = (f'<span id="street-address" itemprop="streetAddress">\n'
                       f'    {street},&nbsp;\n</span>')
    return BeautifulSoup(
        f'<div itemprop="address">{street_span}'
        f'<span id="viewad-locality" itemprop="addressLocality">\n'
        f'    {locality}</span></div>', 'lxml')


@pytest.mark.parametrize("street,locality,expected", [
    # The street is there on about half the listings
    ("Bülowstraße 7", "40476 Düsseldorf - Derendorf",
     "Bülowstraße 7, 40476 Düsseldorf, Derendorf"),
    # The rest only name the district, as the search results do
    ("", "40476 Düsseldorf - Derendorf", "40476 Düsseldorf, Derendorf"),
    # Outside the big cities the page names the state, not a city
    ("", "41061 Nordrhein-Westfalen - Mönchengladbach", "41061 Mönchengladbach"),
    # Nothing at all - the caller keeps the address it has
    ("", "", ""),
])
def test_address_from_page(crawler, street, locality, expected):
    assert crawler._address_from_page(address_page(street, locality)) == expected


def test_address_from_page_feeds_the_geocoder(crawler):
    soup = address_page("Bülowstraße 7", "40476 Düsseldorf - Derendorf")
    location = location_for({'address': crawler._address_from_page(soup),
                             'crawler': 'Kleinanzeigen'})
    assert location['exact_query'] == "Bülowstraße 7, 40476 Düsseldorf"
    assert location['district'] == "Derendorf"
    assert location['city'] == "Düsseldorf"
