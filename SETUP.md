# Local setup notes

Personal flathunter setup for Düsseldorf apartment hunting.
Fork of [flathunters/flathunter](https://github.com/flathunters/flathunter).

## Running it

```bash
./run.sh              # normal run, loops forever
./run.sh -hb day      # also send a daily "still alive" heartbeat
./web.sh              # local web interface at http://127.0.0.1:8080
./tunnel.sh           # publish that interface at https://flathunter.sinacodes.de
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

**Filter by portal.** Chips above the listings narrow to one source
(ImmoScout24, Immowelt, Kleinanzeigen, WG-Gesucht) with a count on each. The
choice is carried in the URL as `?source=…`, so it survives paging and can be
bookmarked. An unrecognised value falls back to showing everything.

**Available from ("frei ab").** Where a landlord states it, the card shows
`ab <date>`. How it is obtained differs by portal:

| Portal | Source | Extra request? |
|---|---|---|
| WG-Gesucht | search results | no |
| Immowelt | search results (the card's link title) | no |
| ImmoScout24 | the listing's own page | yes |
| Kleinanzeigen | the listing's own page | yes |

The last two need `crawl_expose_details: true` in `config.yaml` (on by
default here). That costs one request per listing, but only for listings that
already passed your filters, so a normal run adds a handful, not hundreds.
Set it to `false` to turn it off.

Coverage is limited by what landlords actually fill in — around 70% of
ImmoScout listings, 57% of Kleinanzeigen, a quarter of Immowelt.

**Important: a normal run does not backfill.** Enrichment happens only for
listings that pass the filters, and listings already reported are filtered out
before that. So anything collected before this was enabled will never get a
date from `./run.sh`. Use the one-off backfill instead:

```bash
.venv/bin/python backfill_details.py            # fill in what is missing
.venv/bin/python backfill_details.py --dry-run  # just report what it would do
```

It skips listings that already have a date, waits between requests, and can be
re-run safely — options are `--limit N` and `--delay SECONDS`.

Backfilled data survives later crawls: `save_expose` merges rather than
overwrites, so a fresh search result cannot wipe a field it does not carry.

**Restarting matters.** Python loads the code at startup, so editing files does
nothing to an already-running crawler. After pulling changes, stop `./run.sh`
with Ctrl-C and start it again.

**Found time.** Each card shows when the crawler first picked the listing up,
as a relative time. Hover for the exact timestamp. This is when *we* first saw
it, not when the landlord posted it — the portals do not reliably expose that.

**Un-seeing.** Opening a listing marks it seen automatically. Click the "Seen"
badge on a card to mark it unseen again.

**Starring.** The ☆ on each card keeps a listing on the **Starred** page, so
shortlisted flats live in one place. Clicking the star does not open the
listing. The Starred page deliberately ignores the `filters:` block: something
you starred stays reachable even if you later narrow the price or size range.
Stars live in the `starred_exposes` table. To clear them all:

```bash
.venv/bin/python -c "import sqlite3; c=sqlite3.connect('processed_ids.db'); c.execute('delete from starred_exposes'); c.commit()"
```

**Ordering.** Listings sort newest-first by when they were *first seen*. Each
crawl re-saves everything still online, so that timestamp is deliberately never
rewritten — otherwise the whole table would carry the time of the latest run and
the page would sort by whichever crawler finished last.

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

## Publishing the web interface (Cloudflare tunnel)

`./tunnel.sh` makes the local web interface reachable at
https://flathunter.sinacodes.de, from a phone or anywhere else.

### How it works

- `./web.sh` serves the page on this computer only, at `127.0.0.1:8080`.
- `./tunnel.sh` runs `cloudflared`, which opens an outgoing connection to
  Cloudflare. Visitors of `flathunter.sinacodes.de` reach Cloudflare, and
  Cloudflare passes them down that connection to port 8080.
- No router ports are opened and the home IP address stays hidden. If the
  computer is off, or either script is stopped, the site is down.

Everything the tunnel needs lives in `~/.cloudflared/`:

| File | What it is |
|---|---|
| `flathunter.yml` | Which tunnel to run and where to send visitors |
| `<tunnel-id>.json` | The tunnel's password. Keep it secret, never commit it |
| `cert.pem` | Your Cloudflare account login. Only needed to create, delete or route tunnels, not to run one |
| `config.yml` + another `.json` | The separate easy-german tunnel. Leave them alone |

`flathunter.yml` looks like this:

```yaml
tunnel: <tunnel-id>
credentials-file: /Users/<user>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: flathunter.sinacodes.de
    service: http://localhost:8080
  # Anything else hitting this tunnel gets a 404 rather than being proxied.
  - service: http_status:404
```

The tunnel is called `flathunter` in Cloudflare. `tunnel.sh` runs it with
`cloudflared tunnel --config ~/.cloudflared/flathunter.yml run flathunter`.
It is kept separate from the easy-german tunnel, so restarting one site never
takes the other down.

### Setting it up on another computer (Linux or Mac)

**1. Get flathunter running there first.** Clone the repo, create `.venv`,
and copy `config.yaml` over. Copy `processed_ids.db` too if you want the
listings, stars and seen marks you already have. Check that `./web.sh` works
and http://127.0.0.1:8080 opens before touching the tunnel.

**2. Install `cloudflared`.**

Mac:

```bash
brew install cloudflared
```

Linux (Debian/Ubuntu):

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install cloudflared
```

Other Linux versions: Cloudflare's download page has an `.rpm` package and a
single-file binary. Check the install with `cloudflared --version`.

**3. Connect the tunnel.** Pick one of the two options below.

#### Option A: Move the existing tunnel (simplest)

Same tunnel, same address, just running on a different computer.

1. Copy `~/.cloudflared/flathunter.yml` and `~/.cloudflared/<tunnel-id>.json`
   from the old computer to `~/.cloudflared/` on the new one (`scp`, USB
   stick, ...). The tunnel id is in the `tunnel:` line of `flathunter.yml`.
2. On the new computer, fix the `credentials-file:` line in `flathunter.yml`
   to the new home folder. It must be a full path:
   - Mac: `/Users/<user>/.cloudflared/<tunnel-id>.json`
   - Linux: `/home/<user>/.cloudflared/<tunnel-id>.json`
3. **Stop the tunnel on the old computer.** If both run it at once,
   Cloudflare splits visitors between them, and you see two different sets of
   listings at random.
4. Run `./web.sh` in one terminal and `./tunnel.sh` in another.

No login and no `cert.pem` are needed for this.

#### Option B: Create a new tunnel

For when the files cannot be copied, or the old computer should keep its own
tunnel for something else.

```bash
cloudflared tunnel login                  # opens a browser; pick sinacodes.de, saves cert.pem
cloudflared tunnel create flathunter-2    # prints the new tunnel id, saves <new-id>.json
cloudflared tunnel route dns --overwrite-dns flathunter-2 flathunter.sinacodes.de
```

The name has to be new because `flathunter` already exists in the account.
`--overwrite-dns` moves the address from the old tunnel to the new one, so
the old computer stops getting visitors.

Then write `~/.cloudflared/flathunter.yml` as shown above, with the new id in
`tunnel:` and `credentials-file:`. In `tunnel.sh`, change the last word from
`flathunter` to `flathunter-2`.

Once the new one works, delete the old tunnel from any computer that has
`cert.pem`:

```bash
cloudflared tunnel delete flathunter
```

**4. Check it.**

```bash
cloudflared tunnel list                   # the tunnel should show connections
curl -I https://flathunter.sinacodes.de   # should answer, not 502
```

A **502** means the tunnel is up but `./web.sh` is not running. A **1033**
error page means no `cloudflared` is connected for that address.

### Keeping it running after a reboot

The scripts only run while their terminal is open. To start them on their
own, run them as services. The examples assume the repo is at `~/flathunter`;
change the paths if not. `./run.sh` can be set up the same way.

Do not use `cloudflared service install` for this. It reads
`~/.cloudflared/config.yml`, which is the easy-german tunnel.

**Linux (systemd).** Create `~/.config/systemd/user/flathunter-web.service`:

```ini
[Unit]
Description=flathunter web interface

[Service]
ExecStart=%h/flathunter/web.sh
Restart=on-failure

[Install]
WantedBy=default.target
```

and `~/.config/systemd/user/flathunter-tunnel.service`:

```ini
[Unit]
Description=flathunter Cloudflare tunnel
After=flathunter-web.service network-online.target

[Service]
ExecStart=%h/flathunter/tunnel.sh
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now flathunter-web flathunter-tunnel
sudo loginctl enable-linger "$USER"       # keep them running when logged out
journalctl --user -u flathunter-tunnel -f # watch the tunnel's log
```

**Mac (launchd).** Create
`~/Library/LaunchAgents/de.sinacodes.flathunter-tunnel.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>de.sinacodes.flathunter-tunnel</string>
    <key>ProgramArguments</key>
    <array><string>/Users/USER/flathunter/tunnel.sh</string></array>
    <!-- launchd does not see Homebrew's folder unless told -->
    <key>EnvironmentVariables</key>
    <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardErrorPath</key><string>/tmp/flathunter-tunnel.log</string>
</dict>
</plist>
```

Replace `USER` with your user name. Make a second one for `web.sh` the same
way (another label and file name). Start each with:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/de.sinacodes.flathunter-tunnel.plist
```

and stop it with `launchctl bootout` and the same arguments. The Mac must not
go to sleep for the site to stay up.

### Who can see the page

Anyone who knows the address, unless Cloudflare Access is set up for it in
the Cloudflare dashboard (Zero Trust → Access → Applications). The web
interface has no login of its own that guards the listings. It shows the
listings you collected and lets visitors star them and mark them seen, so
putting Access in front of it (for example a code sent to your email) is
worth doing. It is
free for a few users.

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
  paging, a `seen_exposes` table recording which listings you have opened, and a
  `starred_exposes` table for the shortlist. `get_exposes_page` also returns
  each listing's `created_at` and can restrict to a set of source portals;
  `count_by_crawler` backs the filter chip counts.
- `flathunter/web/static/app.js` — the page's behaviour (seen, starring,
  relative last-run time), moved out of an inline script and shared by both
  listing views.
- `flathunter/crawler/immobilienscout.py` — adds `get_expose_details`, reading
  "Bezugsfrei ab" from the mobile expose API, since the search endpoint returns
  only price, size and rooms.
- `flathunter/crawler/immowelt.py` — parses "frei ab" out of the search result
  card, and no longer requests expose pages at all: Immowelt serves those
  behind a DataDome challenge that returns 403.
- `flathunter/crawler/kleinanzeigen.py` — its "Verfügbar ab" parser anchored
  the date regex at the start of the text, where the label sits, so it never
  matched, and it then filled the field with today's date — claiming every flat
  was available immediately. Fixed, and the bogus fallback removed.
- `flathunter/hunter.py` — record the run time at the end of a hunt. Only
  `WebHunter` did this, so a command-line run left the web interface reporting
  "Last run: never" forever.
- `backfill_details.py` — fills in availability dates for listings already
  stored, which a normal crawl will not revisit.
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
  hosted service with Telegram-login auth. Don't expose it to a network
  directly; if you publish it through the tunnel, see "Who can see the page"
  above.

## Staying up to date

```bash
git fetch upstream
git rebase upstream/main    # from the privacy-and-local-setup branch
```
