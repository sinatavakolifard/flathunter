"""Expose crawler for Kleinanzeigen"""
import re

from bs4 import Tag

from flathunter.abstract_crawler import Crawler
from flathunter.logging import logger

class Kleinanzeigen(Crawler):
    """Implementation of Crawler interface for Kleinanzeigen"""

    URL_PATTERN = re.compile(r'https://www\.kleinanzeigen\.de')
    MONTHS = {
        "Januar": "01",
        "Februar": "02",
        "März": "03",
        "April": "04",
        "Mai": "05",
        "Juni": "06",
        "Juli": "07",
        "August": "08",
        "September": "09",
        "Oktober": "10",
        "November": "11",
        "Dezember": "12"
    }

    # For the big cities the listing page names the city before the district
    # ("40476 Düsseldorf - Derendorf"); for everywhere else it names the
    # federal state instead ("41061 Nordrhein-Westfalen - Mönchengladbach"),
    # which is not part of an address and only confuses the geocoder.
    STATES = {
        "Baden-Württemberg", "Bayern", "Berlin", "Brandenburg", "Bremen",
        "Hamburg", "Hessen", "Mecklenburg-Vorpommern", "Niedersachsen",
        "Nordrhein-Westfalen", "Rheinland-Pfalz", "Saarland", "Sachsen",
        "Sachsen-Anhalt", "Schleswig-Holstein", "Thüringen"
    }

    @staticmethod
    def _text_of(soup, element_id):
        """The cleaned-up text of an element, or "" if the page has none"""
        element = soup.find(id=element_id)
        if not isinstance(element, Tag):
            return ""
        text = element.get_text(" ", strip=True).replace("\xa0", " ")
        return " ".join(text.split()).strip(" ,")

    def _address_from_page(self, soup):
        """The address the listing page gives, as complete as it gets

        The page keeps the street in #street-address ("Bülowstraße 7,") next
        to the area in #viewad-locality ("40476 Düsseldorf - Derendorf").
        About half the listings name a street; the search results never show
        one, so this is the only place to pick it up.

        Returned comma-separated, "Bülowstraße 7, 40476 Düsseldorf,
        Derendorf" - the shape flathunter.geo reads into a street query plus
        a district, so these listings get an exact pin on the map instead of
        a district blob. Returns "" for a page with no address at all (an
        expired listing, say), so callers keep what they already have.
        """
        locality = self._text_of(soup, "viewad-locality")
        if not locality:
            return ""
        street = self._text_of(soup, "street-address")
        city, _, district = (part.strip() for part in locality.partition(" - "))
        plz, _, region = city.partition(" ")
        if district and region in self.STATES:
            # Not a city name - keep the postcode next to the place instead
            city, district = f"{plz} {district}", ""
        return ", ".join(part for part in (street, city, district) if part)

    def get_expose_details(self, expose):
        """Fetch the availability date and the exact address

        Both sit on the listing page, so the one request covers them.

        Kleinanzeigen writes the date as "Verfügbar ab August 2026" - a month
        and year, no day - and only when the landlord filled the field in,
        which is a minority of listings.

        The previous implementation anchored its date regex at the start of
        the text, where the label sits, so it never matched, and then filled
        `from` with today's date - claiming every flat was available now.
        """
        soup = self.get_page(expose['url'])
        for detail in soup.find_all('li', {"class": "addetailslist--detail"}):
            text = " ".join(detail.get_text(" ", strip=True).split())
            if not text.startswith("Verfügbar ab"):
                continue
            match = re.search(r'(\w+)\s+(\d{4})', text[len("Verfügbar ab"):])
            if match is not None and match[1] in self.MONTHS:
                expose['from'] = f"01.{self.MONTHS[match[1]]}.{match[2]}"
            break
        address = self._address_from_page(soup)
        if address:
            expose['address'] = address
        return expose

    def _parse_result(self, item):
        """Parse a single search-result <li> into an expose dictionary"""
        article = item.find("article", attrs={"data-adid": True})
        if not isinstance(article, Tag):
            return None

        # Promoted/ad slots carry no heading - skip them
        title_el = item.find("h3")
        if not isinstance(title_el, Tag):
            return None

        href = article.get("data-href") or ""
        if not href:
            link = item.find("a", href=True)
            href = link["href"] if isinstance(link, Tag) else ""
        if not href:
            return None

        price, facts = "", ""
        for para in item.find_all("p"):
            text = " ".join(para.get_text(" ", strip=True).split())
            if not price and "\u20ac" in text:
                price = text
            elif not facts and ("m\u00b2" in text or "Zi." in text):
                facts = text

        # facts look like "35 m\u00b2 \u00b7 1,5 Zi."
        size_match = re.search(r"[\d.,]+\s*m\u00b2", facts)
        size = size_match.group().strip() if size_match else ""
        rooms_match = re.search(r"([\d.,]+)\s*Zi\.", facts)
        rooms = rooms_match.group(1) if rooms_match else ""

        address = ""
        for element in item.find_all(["div", "span"]):
            text = " ".join(element.get_text(" ", strip=True).split())
            if re.match(r"^\d{5}\s\S", text) and len(text) < 60:
                address = text
                break

        image = None
        img_el = item.find("img")
        if isinstance(img_el, Tag):
            image = img_el.get("src") or img_el.get("data-src")

        return {
            'id': int(article["data-adid"]),
            'image': image,
            'url': "https://www.kleinanzeigen.de" + href,
            'title': " ".join(title_el.get_text(" ", strip=True).split()),
            'price': price,
            'size': size,
            'rooms': rooms,
            'address': address,
            'crawler': self.get_name()
        }

    def extract_data(self, raw_data):
        """Extracts all exposes from a provided Soup object"""
        entries = []
        results = raw_data.find(id="srchrslt-adtable")
        if not isinstance(results, Tag):
            logger.warning("No Kleinanzeigen results container found")
            return entries

        for item in results.find_all("li", recursive=False):
            details = self._parse_result(item)
            if details is not None:
                entries.append(details)

        logger.debug('Number of entries found: %d', len(entries))

        return entries

    def load_address(self, url):
        """Extract address from expose itself"""
        return self._address_from_page(self.get_page(url))
