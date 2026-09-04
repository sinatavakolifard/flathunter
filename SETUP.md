# Local setup notes

Personal flathunter setup for Düsseldorf apartment hunting.
Fork of [flathunters/flathunter](https://github.com/flathunters/flathunter).

## Running it

```bash
./run.sh              # normal run, loops forever
./run.sh -hb day      # also send a daily "still alive" heartbeat
```

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

## Which portals are active

| Portal | Status | Notes |
|---|---|---|
| ImmoScout24 | working | Uses the mobile app API. Anonymous, no login, no captcha. |
| WG-Gesucht | working | Plain scraping, no login. |
| Immowelt | working | Patched locally — see below. Note it injects nearby-city results (Duisburg, Neuss, Mettmann) into the Düsseldorf list; no URL parameter suppresses this. |
| Kleinanzeigen | disabled | Upstream selectors are stale, returns 0 results. |

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
- `.gitignore` — added `.venv/`.

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
- **`main.py`** — that's the multi-user hosted web service, not the local bot.
  Don't run or expose it. Use `flathunt.py` (which `run.sh` calls).

## Staying up to date

```bash
git fetch upstream
git rebase upstream/main    # from the privacy-and-local-setup branch
```
