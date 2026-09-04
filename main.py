""" Startup file for Google Cloud deployment or local webserver"""
import os

from flathunter.argument_parser import parse
from flathunter.idmaintainer import IdMaintainer
from flathunter.web_hunter import WebHunter
from flathunter.config import Config
from flathunter.logging import configure_logging

from flathunter.web import app

# load config
args = parse()
config_handle = args.config
if config_handle is not None:
    config = Config(config_handle.name)
else:
    config = Config()

if __name__ == '__main__':
    # Use the SQLite DB file if we are running locally
    id_watch = IdMaintainer(f'{config.database_location()}/processed_ids.db')
else:
    # Load the driver manager from local cache (if chrome_driver_install.py has been run
    os.environ['WDM_LOCAL'] = '1'
    # Use Google Cloud DB if we run on the cloud. Imported here rather than at
    # module level so a local run does not need firebase-admin installed.
    from flathunter.googlecloud_idmaintainer import GoogleCloudIdMaintainer
    id_watch = GoogleCloudIdMaintainer(config)

configure_logging(config)

# initialize search plugins for config
config.init_searchers()

hunter = WebHunter(config, id_watch)

app.config["HUNTER"] = hunter
_website = config.get('website', {}) or {}
# How many listings per page (upstream hardcodes 9 with no paging at all)
app.config["EXPOSES_PER_PAGE"] = int(_website.get('exposes_per_page', 30))
# Cap on pages: absent or blank means unlimited, 1 means no pagination controls
_max_pages = _website.get('max_pages', None)
app.config["MAX_PAGES"] = (
    max(1, int(_max_pages)) if _max_pages not in (None, '', False) else None)
if config.has_website_config():
    app.secret_key = config.website_session_key()
    app.config["DOMAIN"] = config.website_domain()
    app.config["BOT_NAME"] = config.website_bot_name()
else:
    app.secret_key = b'Not a secret'
notifiers = config.notifiers()
if "telegram" in notifiers:
    app.config["BOT_TOKEN"] = config.telegram_bot_token()
if "mattermost" in notifiers:
    app.config["MM_WEBHOOK_URL"] = config.mattermost_webhook_url()

if __name__ == '__main__':
    listen = config['website'].get('listen', {})
    host = listen.get('host', '127.0.0.1')
    port = listen.get('port', '8080')
    # debug=True enables the Werkzeug debugger, which allows arbitrary code
    # execution by anyone who can reach the port. Off unless explicitly asked
    # for in config under website.listen.debug.
    app.run(host=host, port=port, debug=listen.get('debug', False))
