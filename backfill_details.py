#!/usr/bin/env python
"""Fill in availability dates and addresses for listings already in the database.

A normal crawl only enriches listings that pass the filters, and listings
already reported are filtered out before that happens - so anything collected
before detail-crawling was enabled never gets a date. Likewise, WG-Gesucht
listings saved before addresses were stored only have their link as the
address, and Kleinanzeigen listings saved before the crawler read the street
off the listing page only have their district. This walks the stored listings
and fetches the missing ones.

Usage:
    .venv/bin/python backfill_details.py [--limit N] [--dry-run] [--delay S] [--addresses-only]
"""
import argparse
import json
import re
import sqlite3
import sys
import time

from flathunter.config import Config
from flathunter.idmaintainer import IdMaintainer
from flathunter.logging import logger


def parse_args():
    """Command-line options"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', '-c', default='config.yaml')
    parser.add_argument('--limit', '-n', type=int, default=None,
                        help='Stop after this many listings')
    parser.add_argument('--delay', '-d', type=float, default=0.7,
                        help='Seconds to wait between requests (default 0.7)')
    parser.add_argument('--addresses-only', action='store_true',
                        help='Only fill in missing addresses, skip dates')
    parser.add_argument('--dry-run', action='store_true',
                        help='Report what would be fetched, change nothing')
    return parser.parse_args()


def searcher_for(config, url):
    """The crawler that handles a given listing URL"""
    for searcher in config.searchers():
        if searcher.URL_PATTERN.search(url):
            return searcher
    return None


def main():
    """Walk stored listings without a date and try to fill them in"""
    args = parse_args()
    config = Config(args.config)
    config.init_searchers()
    db_path = f'{config.database_location()}/processed_ids.db'
    id_watch = IdMaintainer(db_path)

    rows = sqlite3.connect(db_path).execute(
        'SELECT details, crawler FROM exposes ORDER BY created DESC').fetchall()

    todo = []
    for details, crawler in rows:
        expose = json.loads(details)
        searcher = searcher_for(config, expose.get('url', ''))
        if searcher is None:
            continue
        # Immowelt's expose pages are behind a captcha and its list results
        # already carry the date, so there is nothing to fetch there
        needs_date = not args.addresses_only and not expose.get('from') \
            and type(searcher).__name__ != 'Immowelt'
        address = expose.get('address') or ''
        # WG-Gesucht keeps the listing link until an address is looked up
        needs_address = address.startswith('http')
        # Kleinanzeigen search results only ever name the district
        # ("40476 Derendorf"); about half the listing pages name the street.
        # An address read off a listing page is comma-separated, so the ones
        # that turned out to have no street are not fetched again.
        if type(searcher).__name__ == 'Kleinanzeigen' \
                and re.match(r'^\d{5}\b', address) and ',' not in address:
            needs_address = True
        if not (needs_date or needs_address):
            continue
        todo.append((expose, searcher, crawler, needs_date, needs_address))

    if args.limit:
        todo = todo[:args.limit]

    print(f'{len(todo)} listings without an availability date or exact address to try')
    if args.dry_run:
        for expose, _, crawler, needs_date, needs_address in todo[:20]:
            missing = '+'.join(name for name, needed in
                               (('date', needs_date), ('address', needs_address)) if needed)
            print(f'  would fetch {crawler:16s} {missing:12s} {expose.get("title", "")[:45]}')
        return

    dates_filled = 0
    addresses_filled = 0
    for index, (expose, searcher, crawler, needs_date, needs_address) in \
            enumerate(todo, start=1):
        updated = dict(expose)
        found = []
        if needs_date:
            try:
                updated = searcher.get_expose_details(updated) or updated
            except Exception as error:  # pylint: disable=broad-except
                logger.debug('Could not load details for %s: %s', expose.get('url'), error)
            if updated.get('from'):
                dates_filled += 1
                found.append(updated['from'])
        if needs_address and updated.get('address') == expose.get('address'):
            # The detail crawl above already fills the address in for some
            # portals - only fetch the page again when it did not, or did
            # not run. WG-Gesucht stores the link in place of the address.
            link = expose['address'] if str(expose.get('address', '')).startswith('http') \
                else expose.get('url')
            try:
                address = searcher.load_address(link)
            except Exception as error:  # pylint: disable=broad-except
                logger.debug('Could not load address for %s: %s', expose.get('url'), error)
                address = None
            if address:
                updated['address'] = address
        if updated.get('address') != expose.get('address'):
            addresses_filled += 1
            found.append(updated['address'])
        if found:
            id_watch.save_expose(updated)
        print(f'  [{index}/{len(todo)}] {crawler:16s} '
              f'{" | ".join(found) if found else "--":40s} {expose.get("title", "")[:35]}')
        time.sleep(args.delay)

    print(f'\nFilled in {dates_filled} dates and {addresses_filled} addresses '
          f'across {len(todo)} listings.')
    print('The rest do not state them.')


if __name__ == '__main__':
    sys.exit(main())
