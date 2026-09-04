"""SQLite implementation of IDMaintainer interface"""
import threading
import sqlite3 as lite
import datetime
import json

from flathunter.logging import logger
from flathunter.abstract_processor import Processor

__author__ = "Nody"
__version__ = "0.1"
__maintainer__ = "Nody"
__email__ = "harrymcfly@protonmail.com"
__status__ = "Prodction"

class SaveAllExposesProcessor(Processor):
    """Processor that saves all exposes to the database"""

    def __init__(self, config, id_watch):
        self.config = config
        self.id_watch = id_watch

    def process_expose(self, expose):
        """Save a single expose"""
        self.id_watch.save_expose(expose)
        return expose

class IdMaintainer:
    """SQLite back-end for the database"""

    def __init__(self, db_name):
        self.db_name = db_name
        self.threadlocal = threading.local()

    def get_connection(self):
        """Connects to the SQLite database. Connections are thread-local"""
        connection = getattr(self.threadlocal, 'connection', None)
        if connection is None:
            try:
                self.threadlocal.connection = lite.connect(self.db_name)
                connection = self.threadlocal.connection
                cur = self.threadlocal.connection.cursor()
                cur.execute('CREATE TABLE IF NOT EXISTS processed (ID INTEGER)')
                cur.execute('CREATE TABLE IF NOT EXISTS executions (timestamp timestamp)')
                cur.execute('CREATE TABLE IF NOT EXISTS exposes (id INTEGER, created TIMESTAMP, \
                                    crawler STRING, details BLOB, PRIMARY KEY (id, crawler))')
                cur.execute('CREATE TABLE IF NOT EXISTS users \
                                    (id INTEGER PRIMARY KEY, settings BLOB)')
                cur.execute('CREATE TABLE IF NOT EXISTS seen_exposes \
                                    (id INTEGER PRIMARY KEY, seen_at TIMESTAMP)')
                self.threadlocal.connection.commit()
            except lite.Error as error:
                logger.error("Error %s:", error.args[0])
                raise error
        return connection

    def is_processed(self, expose_id):
        """Returns true if an expose has already been processed"""
        logger.debug('is_processed(%d)', expose_id)
        cur = self.get_connection().cursor()
        cur.execute('SELECT id FROM processed WHERE id = ?', (expose_id,))
        row = cur.fetchone()
        return row is not None

    def mark_processed(self, expose_id):
        """Mark an expose as processed in the database"""
        logger.debug('mark_processed(%d)', expose_id)
        cur = self.get_connection().cursor()
        cur.execute('INSERT INTO processed VALUES(?)', (expose_id,))
        self.get_connection().commit()

    def save_expose(self, expose):
        """Saves an expose to a database"""
        cur = self.get_connection().cursor()
        cur.execute('INSERT OR REPLACE INTO exposes(id, created, crawler, details) \
                     VALUES (?, ?, ?, ?)',
                    (int(expose['id']), datetime.datetime.now(),
                     expose['crawler'], json.dumps(expose)))
        self.get_connection().commit()

    def get_exposes_since(self, min_datetime):
        """Loads all exposes since the specified date"""
        def row_to_expose(row):
            obj = json.loads(row[2])
            obj['created_at'] = row[0]
            return obj
        cur = self.get_connection().cursor()
        cur.execute('SELECT created, crawler, details FROM exposes \
                     WHERE created >= ? ORDER BY created DESC', (min_datetime,))
        return list(map(row_to_expose, cur.fetchall()))

    def get_recent_exposes(self, count, filter_set=None):
        """Returns up to 'count' recent exposes, filtered by the provided filter"""
        cur = self.get_connection().cursor()
        cur.execute('SELECT details FROM exposes ORDER BY created DESC')
        res = []
        next_batch = []
        while len(res) < count:
            if len(next_batch) == 0:
                next_batch = cur.fetchmany()
                if len(next_batch) == 0:
                    break
            expose = json.loads(next_batch.pop()[0])
            if filter_set is None or filter_set.is_interesting_expose(expose):
                res.append(expose)
        return res

    def get_exposes_page(self, offset, limit, filter_set=None):
        """Return one page of exposes plus whether any follow

        Filtering happens in Python rather than SQL, since the filters
        operate on the JSON blob, so we walk the rows in date order and
        count matches until we have skipped `offset` of them and collected
        `limit` more.
        """
        cur = self.get_connection().cursor()
        cur.execute('SELECT details FROM exposes ORDER BY created DESC')
        matched = 0
        page = []
        has_more = False
        while True:
            row = cur.fetchone()
            if row is None:
                break
            expose = json.loads(row[0])
            if filter_set is not None and not filter_set.is_interesting_expose(expose):
                continue
            matched += 1
            if matched <= offset:
                continue
            if len(page) < limit:
                page.append(expose)
            else:
                # One match beyond the page is enough to know there is a next one
                has_more = True
                break
        return page, has_more

    def count_exposes(self, filter_set=None):
        """Total number of exposes matching the filter"""
        cur = self.get_connection().cursor()
        cur.execute('SELECT details FROM exposes')
        if filter_set is None:
            return len(cur.fetchall())
        return sum(1 for row in cur.fetchall()
                   if filter_set.is_interesting_expose(json.loads(row[0])))

    def mark_seen(self, expose_id):
        """Record that the user has opened this listing"""
        cur = self.get_connection().cursor()
        cur.execute('INSERT OR REPLACE INTO seen_exposes VALUES (?, ?)',
                    (int(expose_id), datetime.datetime.now()))
        self.get_connection().commit()

    def unmark_seen(self, expose_id):
        """Forget that the user opened this listing"""
        cur = self.get_connection().cursor()
        cur.execute('DELETE FROM seen_exposes WHERE id = ?', (int(expose_id),))
        self.get_connection().commit()

    def get_seen_ids(self):
        """Set of expose ids the user has opened"""
        cur = self.get_connection().cursor()
        cur.execute('SELECT id FROM seen_exposes')
        return {row[0] for row in cur.fetchall()}

    def save_settings_for_user(self, user_id, settings):
        """Saves the user settings to the database"""
        cur = self.get_connection().cursor()
        cur.execute('INSERT OR REPLACE INTO users VALUES (?, ?)', (user_id, json.dumps(settings)))
        self.get_connection().commit()

    def get_settings_for_user(self, user_id):
        """Loads the settings for a user from the database"""
        cur = self.get_connection().cursor()
        cur.execute('SELECT settings FROM users WHERE id = ?', (user_id,))
        row = cur.fetchone()
        if row is None:
            return None
        return json.loads(row[0])

    def get_user_settings(self):
        """Loads all users' settings from the database"""
        cur = self.get_connection().cursor()
        cur.execute('SELECT id, settings FROM users')
        res = []
        for row in cur.fetchall():
            res.append((row[0], json.loads(row[1])))
        return res

    def get_last_run_time(self):
        """Returns the time of the last hunt"""
        cur = self.get_connection().cursor()
        cur.execute("SELECT * FROM executions ORDER BY timestamp DESC LIMIT 1")
        row = cur.fetchone()
        if row is None:
            return None
        return datetime.datetime.strptime(row[0], '%Y-%m-%d %H:%M:%S.%f')

    def update_last_run_time(self):
        """Saves the time of the most recent hunt to the database"""
        cur = self.get_connection().cursor()
        result = datetime.datetime.now()
        cur.execute('INSERT INTO executions VALUES(?);', (result,))
        self.get_connection().commit()
        return result
