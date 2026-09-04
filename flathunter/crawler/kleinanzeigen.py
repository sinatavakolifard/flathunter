"""Expose crawler for Kleinanzeigen"""
import re
import datetime

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

    def get_expose_details(self, expose):
        soup = self.get_page(expose['url'])
        for detail in soup.find_all('li', {"class": "addetailslist--detail"}):
            if re.match(r'Verfügbar ab', detail.text):
                date_string = re.match(r'(\w+) (\d{4})', detail.text)
                if date_string is not None:
                    expose['from'] = "01." + self.MONTHS[date_string[1]] + "." + date_string[2]
        if 'from' not in expose:
            expose['from'] = datetime.datetime.now().strftime('%02d.%02m.%Y')
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
        expose_soup = self.get_page(url)
        street_raw = ""
        street_el = expose_soup.find(id="street-address")
        if isinstance(street_el, Tag):
            street_raw = street_el.text
        address_raw = ""
        address_el = expose_soup.find(id="viewad-locality")
        if isinstance(address_el, Tag):
            address_raw = address_el.text

        return address_raw.strip().replace("\n", "") + " " + street_raw.strip()
