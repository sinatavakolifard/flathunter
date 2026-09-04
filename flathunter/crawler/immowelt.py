"""Expose crawler for ImmoWelt"""
import re
import hashlib

from bs4 import BeautifulSoup, Tag

from flathunter.logging import logger
from flathunter.abstract_crawler import Crawler

class Immowelt(Crawler):
    """Implementation of Crawler interface for ImmoWelt"""

    URL_PATTERN = re.compile(r'https://www\.immowelt\.de')

    def __init__(self, config):
        super().__init__(config)
        self.config = config

    def get_expose_details(self, expose):
        """Nothing to fetch - the search results already carry everything

        Immowelt serves its expose pages behind a DataDome challenge, so
        requesting them returns 403 and a captcha rather than content. The
        availability date is parsed from the search result card instead, so
        there is nothing this needs to add.
        """
        return expose

    def extract_data(self, raw_data: BeautifulSoup):
        """Extracts all exposes from a provided Soup object"""
        entries = []
        soup_res = raw_data
        if not isinstance(soup_res, Tag):
            return []

        core_list = soup_res.find("div",
            attrs={"data-testid": "serp-core-scrollablelistview-testid"})
        if not isinstance(core_list, Tag):
            return []
        advertisements = core_list.find_all("div", attrs={"class": "css-79elbk"})
        for adv in advertisements:
            # Immowelt list cards carry no heading element. The only real
            # title is the `title` attribute on the covering link, e.g.
            # "Wohnung zur Miete - Stadtbezirk 2 - 700 EUR - 27 m2".
            # Fall back to the description body (truncated - Immowelt serves
            # up to ~500 characters there), then to the old hashed CSS class.
            title = ""
            link_el = adv.find(
                "a", attrs={"data-testid": "card-mfe-covering-link-testid"})
            if isinstance(link_el, Tag) and link_el.get("title"):
                title = str(link_el["title"])
            if not title:
                desc_el = adv.find(
                    "div", attrs={"data-testid": "cardmfe-description-text-test-id"}
                ) or adv.find("div", {"class": "css-1cbj9xw"})
                if desc_el is not None:
                    title = desc_el.text.strip()
                    if len(title) > 120:
                        title = title[:117].rstrip() + "..."
            # Normalise non-breaking spaces so the message renders cleanly
            title = " ".join(title.split())

            # The link title also carries the availability date when the
            # landlord gave one, e.g. "... 3. Geschoss, frei ab 01.10.2026".
            # No extra request needed.
            available_from = ""
            date_match = re.search(r'frei ab (\d{1,2}\.\d{1,2}\.\d{4})', title)
            if date_match is not None:
                available_from = date_match.group(1)

            try:
                price = adv.find(
                    "div", attrs={"data-testid": "cardmfe-price-testid"}).text
            except AttributeError:
                price = ""

            try:
                descriptions = adv.find("div",
                    attrs={"data-testid": "cardmfe-keyfacts-testid"}).children
                descriptions = [result.text for result in descriptions]
            except AttributeError:
                descriptions = []

            size = list(filter(lambda x: "m²" in x, descriptions))
            try:
                size = size[0]
            except IndexError:
                size = ""

            rooms = list(filter(lambda x: "Zimmer" in x, descriptions))
            try:
                rooms = rooms[0]
            except IndexError:
                rooms = ""

            id_element = adv.find("a")
            try:
                url = id_element.get("href")
                if "https" not in url:
                    url = "https://immowelt.de/" + url
            except (AttributeError, TypeError):
                continue

            picture = adv.find("img")
            image = None
            if picture:
                image = picture.get('src')

            try:
                address = adv.find(
                    "div", attrs={"data-testid": "cardmfe-description-box-address"}
                  ).text
            except AttributeError:
                address = ""
            ad_id = url.split('/')[-1]
            processed_id = int(
              hashlib.sha256(ad_id.encode('utf-8')).hexdigest(), 16
            ) % 10**16

            details = {
                'id': processed_id,
                'image': image,
                'url': url,
                'title': title.strip(),
                'rooms': rooms,
                'price': price,
                'size': size,
                'address': address,
                'from': available_from,
                'crawler': self.get_name()
            }
            entries.append(details)

        logger.debug('Number of entries found: %d', len(entries))
        return entries
