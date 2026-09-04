#!/usr/bin/env python
"""Fill in availability dates for listings already in the database.

A normal crawl only enriches listings that pass the filters, and listings
already reported are filtered out before that happens - so anything collected
before detail-crawling was enabled never gets a date. This walks the stored
listings and fetches the missing ones.

Usage:
    .venv/bin/python backfill_details.py [--limit N] [--dry-run] [--delay S]
"""
import argparse
import json
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
        if expose.get('from'):
            continue
        searcher = searcher_for(config, expose.get('url', ''))
        if searcher is None:
            continue
        # Immowelt's expose pages are behind a captcha and its list results
        # already carry the date, so there is nothing to fetch there
        if type(searcher).__name__ == 'Immowelt':
            continue
        todo.append((expose, searcher, crawler))

    if args.limit:
        todo = todo[:args.limit]

    print(f'{len(todo)} listings without an availability date to try')
    if args.dry_run:
        for expose, _, crawler in todo[:20]:
            print(f'  would fetch {crawler:16s} {expose.get("title", "")[:55]}')
        return

    filled = 0
    for index, (expose, searcher, crawler) in enumerate(todo, start=1):
        try:
            updated = searcher.get_expose_details(dict(expose))
        except Exception as error:  # pylint: disable=broad-except
            logger.debug('Could not load details for %s: %s', expose.get('url'), error)
            updated = None
        if updated and updated.get('from'):
            id_watch.save_expose(updated)
            filled += 1
            print(f'  [{index}/{len(todo)}] {crawler:16s} {updated["from"]}  '
                  f'{updated.get("title", "")[:45]}')
        else:
            print(f'  [{index}/{len(todo)}] {crawler:16s} --          '
                  f'{expose.get("title", "")[:45]}')
        time.sleep(args.delay)

    print(f'\nFilled in {filled} of {len(todo)} listings.')
    print('The rest do not state an availability date.')


if __name__ == '__main__':
    sys.exit(main())
