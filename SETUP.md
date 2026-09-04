# Local setup notes

Personal flathunter setup for Düsseldorf apartment hunting.
Fork of [flathunters/flathunter](https://github.com/flathunters/flathunter).

## Running it

```bash
./run.sh              # normal run, loops forever
./run.sh -hb day      # also send a daily "still alive" heartbeat
./web.sh              # local web interface at http://127.0.0.1:8080
```

`run.sh` does the searching and notifying. `web.sh` is a separate, read-only
view of what `run.sh` has already collected — it does not crawl on its own, so
run both if you want the page to keep filling up.

Stop with Ctrl-C. Seen listings are remembered in `processed_ids.db`, so you
only ever get notified once per flat.

## Finishing the Telegram setup

`config.yaml` has two placeholders you need to fill in.

1. In Telegram, message **@BotFather**, send `/newbot`, pick a name and a
   username. It replies with a token like `123456789:AAF...`.
2. Put that token in `config.yaml` under `telegram.bot_token`.
3. Open a chat with your new bot and send it any message (e.g. `hi`).
   The bot cannot message you first — this step is required.
4. Get your numeric chat id:
   ```bash
   .venv/bin/python get_chat_id.py <YOUR_BOT_TOKEN>
   ```
5. Put that number in `config.yaml` under `telegram.receiver_ids`.

Then `./run.sh`.

## Troubleshooting

**Telegram returns 404 `Not Found` for every listing.**
The bot token is wrong. Telegram puts the token in the URL path
(`api.telegram.org/bot<TOKEN>/sendMessage`), so an unrecognised token makes the
URL itself nonexistent. A valid token is exactly 46 characters:
10 digits, a colon, then 35 characters. Check you didn't leave a stray
character from the placeholder in front of it. Verify with:

```bash
.venv/bin/python -c "
import yaml, requests
t = yaml.safe_load(open('config.yaml'))['telegram']['bot_token']
print(requests.get(f'https://api.telegram.org/bot{t}/getMe', timeout=30).json())"
```

**Telegram returns 400 `chat not found`.**
The token is fine but `receiver_ids` is wrong. Re-run `get_chat_id.py`.

**Notifications failed, and now those flats never arrive.**
Listings are marked as seen even when the notification fails. Delete the
database to be re-notified about everything currently listed:

```bash
rm -f processed_ids.db
```

**Too many notifications.**
A fresh database treats every current listing as new — expect ~100 messages on
the first run for a city-wide search. Set the price/size filters in
`config.yaml` to narrow it.

## Ways to see the listings

Telegram is what is configured, but it is not the only option.

**Telegram** (active) — fastest, works on your phone, no extra process to keep
running.

**Local web interface** — `./web.sh`, then open http://127.0.0.1:8080. Shows
the listings already in `processed_ids.db` with price, size, rooms and links.
Bound to localhost, so nothing is exposed to the network. It reads the
database; it does not crawl, so keep `./run.sh` going alongside it. The
Telegram login button on the page is for the hosted multi-user service and is
not needed locally — the listings render without logging in.

The page applies the same `filters:` block the notifier uses, so it shows what
you would have been notified about. Two settings control paging:

```yaml
website:
    exposes_per_page: 30   # listings per page
    max_pages:             # blank = unlimited; 1 = single page, no controls
```

`max_pages: 2` (or any number above 1) pages up to that many and no further;
a page number beyond the cap is clamped rather than erroring.

**Clicking a listing marks it as seen.** Seen cards are dimmed and carry a
badge, and the state is stored in the `seen_exposes` table, so it survives
reloads and browser changes. To forget everything you have marked:

```bash
.venv/bin/python -c "import sqlite3; c=sqlite3.connect('processed_ids.db'); c.execute('delete from seen_exposes'); c.commit()"
```

**Last checked** shows when the crawler last completed a pass, as a relative
time that updates in place.

**Apprise** — one notifier covering ~100 services: email (`mailto://`), Signal,
Discord, ntfy, Matrix, Gotify, macOS desktop notifications, and more. Add
`apprise` to `notifiers:` and list target URLs under `apprise:`. See
https://github.com/caronc/apprise for the URL formats.

**Slack / Mattermost** — incoming webhooks, if you use either.

**The database directly** — everything lives in `processed_ids.db`, one JSON
blob per listing:

```bash
.venv/bin/python -c "
import sqlite3, json
for (d,) in sqlite3.connect('processed_ids.db').execute('select details from exposes'):
    e = json.loads(d); print(e['price'], '|', e['size'], '|', e['title'][:60])"
```

Multiple notifiers can be active at once — `notifiers:` is a list.

## Which portals are active

| Portal | Status | Notes |
|---|---|---|
| ImmoScout24 | working | Uses the mobile app API. Anonymous, no login, no captcha. |
| WG-Gesucht | working | Plain scraping, no login. |
| Immowelt | working | Patched locally — see below. Note it injects nearby-city results (Duisburg, Neuss, Mettmann) into the Düsseldorf list; no URL parameter suppresses this. |
| Kleinanzeigen | working | Crawler rewritten locally for the current markup. Plain HTTP, no Chrome. Keep `sleeping_time` at 600s or more — Kleinanzeigen rate-limits by IP. |

## Local changes to upstream

On branch `privacy-and-local-setup`:

- `flathunter/notifiers/sender_telegram.py` — removed two `logger.debug` calls
  that wrote the raw Telegram bot token (and the API URL containing it) into
  the logs whenever verbose mode was on.
- `flathunter/crawler/immowelt.py` — the title selector used a hashed CSS class
  (`css-1cbj9xw`) that Immowelt has since changed, so every listing came
  through with an empty title. Immowelt's cards have no heading element, so the
  title now comes from the covering link's `title` attribute
  (`a[data-testid="card-mfe-covering-link-testid"]`), falling back to a
  truncated description and then to the old class.
- `flathunter/crawler/kleinanzeigen.py` — rewritten for Kleinanzeigen's current
  Tailwind-based markup (the old `article.aditem` selectors match nothing), and
  switched from Chrome to plain HTTP, since the results page is server-rendered.
- `flathunter/web/views.py` — dropped the `flask-api` dependency (upstream pins
  an unpinned git branch of it because the released version is broken with
  modern Werkzeug) in favour of stdlib `http.HTTPStatus`.
- `main.py` — the Google Cloud database backend is now imported lazily, so a
  local run no longer requires `firebase-admin`; and the Werkzeug debugger,
  which allows arbitrary code execution, is off unless explicitly enabled.
- `flathunter/web/views.py` — the index page showed a hardcoded 9 listings and,
  with nobody logged in, applied no filters at all, so it displayed whatever
  had been crawled most recently regardless of price or size. It now pages
  through all matches (`website.exposes_per_page`, `website.max_pages`), and an
  anonymous session falls back to the `filters:` block from `config.yaml`.
  Adds a `/mark_seen` endpoint.
- `flathunter/idmaintainer.py` — adds `get_exposes_page` / `count_exposes` for
  paging, and a `seen_exposes` table recording which listings you have opened.
- `flathunter/hunter.py` — record the run time at the end of a hunt. Only
  `WebHunter` did this, so a command-line run left the web interface reporting
  "Last run: never" forever.
- `web.sh` — starts the local web interface.
- `.gitignore` — added `.venv/`.

## On Kleinanzeigen and APIs

Kleinanzeigen has no public search API. Its only official interface is
OpenImmo *upload* over FTP, for paying business customers — that publishes
listings, it cannot read them.

There is a private mobile-app API at `api.kleinanzeigen.de/api/ads.json`, but it
returns `401 Unauthorized`: it is gated behind credentials compiled into the
app binary. Using those would mean authenticating as the official app with
secrets not issued to us, so this setup does not go there.

None of that turned out to matter, because the search results page is fully
server-rendered — plain HTTP returns every listing with title, price, size,
rooms, address and link. That is what the rewritten crawler uses.

Note the contrast with ImmoScout24: its mobile API at
`api.mobile.immobilienscout24.de` needs no authentication at all, which is why
flathunter can call it directly.

## Settings to leave alone

- **`use_proxy_list`** — routes traffic through random free proxies scraped
  from free-proxy-list.net. Not needed (IS24 works fine directly), and those
  proxy operators can see which sites you are hitting.
- **Captcha solvers** (2captcha / imagetyperz / capmonster) — none configured,
  none needed so far. They send the page URL and captcha site key to a third
  party.
- **`durations` / Google Maps** — if enabled, every listing's address plus your
  own home/work addresses get sent to Google against your API key. Off by
  default.
- **`main.py` bound to a public interface** — running it locally is fine (see
  `./web.sh`, which binds to 127.0.0.1 only), but it is built for a multi-user
  hosted service with Telegram-login auth. Don't expose it to a network.

## Staying up to date

```bash
git fetch upstream
git rebase upstream/main    # from the privacy-and-local-setup branch
```
