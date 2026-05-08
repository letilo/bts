bts - Badminton Tournament Software
==========

Use [bup](https://github.com/phihag/bup/) at tournaments.

## Docker installation

[Install docker](https://docs.docker.com/install/) and run

```
docker run -p 4000:4000 phihag/bts
```

## Manual installation

To install, type

    make

To start, type

	make run  # Production mode
	make dev  # Development mode

# Usage

To start a display, go to http://IP:4000/d2 , where 2 is the court number (alternatively, just `/d`).
To start an umpire panel, go to http://IP:4000/u2 , where 2 is the court number (alternatively, just `/u`).

# Helper scripts

- `./fetch-btp.js` - Fetch data from BTP via TPNetwork protocol
- `div/decode.js` - Decode VisualReality hex format

# Ticker transport

The live ticker push supports two transports, selected by the URL scheme
configured on the tournament (`ticker_url`):

- **`ws://` / `wss://`** — classic persistent WebSocket. Original behavior,
  targets a ticker server like the one in `ticker/`.
- **`http://` / `https://`** — HTTP POST transport (one request per
  message). For receivers that cannot host a long-lived WebSocket server,
  e.g. plain PHP/Apache shared hosting.

Both transports share the same payload schema (`tset` + `tupdate_match`).
The HTTP variant authenticates via `Authorization: Bearer <ticker_password>`
instead of the `?password=` query parameter, keeps a bounded in-memory send
queue, collapses duplicate updates for the same match, and retries with
exponential backoff on transient failures. It stops cleanly when the
tournament's ticker is disabled (`terminate()`).

The receiver endpoint must accept `POST` on a path matching `/update` and
respond with HTTP 2xx plus an optional JSON body `{type:"answer",status:"ok"}`.
Non-2xx triggers retry; a JSON body with `type:"error"` acknowledges the
request but marks the message as rejected (it is not retried).

## Ticker payload: player identifiers and nationalities

Each match in a `tset` payload carries three kinds of parallel arrays per
team side, all aligned 1:1 (same array length, same index ordering):

- `p0` / `p1` — array of player display names
- `p0_member_ids` / `p1_member_ids` — array of federation member IDs
  (e.g. `"08-009763"`) for profile linking downstream. Entries are `null`
  when the BTP source data carried no `MemberID` (common for tournaments
  imported without federation data).
- `p0_nationalities` / `p1_nationalities` — array of ISO 3-letter country
  codes (e.g. `"GER"`, `"FRA"`, `"JPN"`) for flag rendering. Entries are
  `null` if the player object has no country, which lets a receiver fall
  back to a neutral icon without conditional array handling.

These arrays were added in later changes (`feat/ticker-member-ids` and
`feat/ticker-nationalities`) and are backward compatible: receivers that
only look at `p0` / `p1` continue to work unchanged. New receivers can
use the extra arrays to link to external profiles and to render country
flags — both useful when the local profile lookup yields nothing, e.g.
at international tournaments with guest players.

`tupdate_match` messages are unaffected — they continue to carry only
`{_id, s}` and never re-transmit player data. Player identity is
established through the surrounding `tset` snapshot.

## Ticker payload: recently finished matches

Each `tset` payload carries an `event.recent_finished_matches` array
alongside `event.matches`. It contains the last 10 matches that
finished within the previous 4 hours, sorted newest-first. Each entry
uses the same schema as a live match plus two extra fields:

- `end_ts` — Unix timestamp (ms) when the match finished
- `team1_won` — `true` if team 0 (`p0`) won, `false` otherwise

The live `event.matches` array continues to hold only the matches that
are currently on a court. Finished matches remain visible on their
court for up to 15 minutes (unchanged from before), then move out of
`event.matches` but stay in `recent_finished_matches` until the 4-hour
window or the 10-entry cap pushes them out.

`end_ts` and `team1_won` are emitted on a match only when they are set
— running matches on a live court do not carry these fields. Consumers
should treat them as optional.

The field is always present (even as `[]`) for shape stability. A
receiver can iterate it unconditionally.

## Ticker payload: upcoming matches

Each `tset` payload carries an `event.upcoming_matches` array
alongside `event.matches`. It mirrors what BTS itself shows in its
"Next Matches" view: every match that is neither finished nor
currently being played on a live court. Capped at 15 entries, sorted
ascending by `setup.preparation_call_timestamp` — matches that have
been called into preparation float to the bottom in order of
longest-waiting-first; everything not yet called keeps the
import-order from the BTP file at the front of the list.

Each entry uses the same schema as a live match. Five optional
fields are emitted only when set:

- `preparation_call_ts` — Unix timestamp (ms) when the match was
  called into preparation. **Only set by the automation pipeline**
  (`add_preparation_call_timestamp` in `bts/match_utils.js`). Manual
  calls do not write this field.
- `is_called` — `true` when `setup.state === 'preparation'`. Surfaces
  the called state for both manual and automated calls, so a receiver
  can recognize "called into preparation" without depending on the
  timestamp. Use this as the primary "called" indicator and treat
  `preparation_call_ts` as an optional sub-indicator that only the
  automation pipeline emits.
- `match_num` — BTP match number (string) for cross-referencing with
  the printed schedule.
- `scheduled_time_str` — printed-schedule time as a zero-padded
  string (e.g. `"09:35"`). Doubles as the primary sort key for the
  array.
- `scheduled_date` — printed-schedule date in ISO form (`YYYY-MM-DD`).
  Used as the leading sort key, so multi-day tournaments order
  correctly across day boundaries.

Bracket follow-up matches whose participants are not yet decided are
filtered out: a match is included only when at least one team has a
player with a non-empty name. This avoids filling the array with
`TBD vs TBD` rows ahead of the actually-next matches.

Sort order matches BTS' own NeDB query in `bts/match_utils.js`:
ascending by `scheduled_date`, then `scheduled_time_str`, then
`match_order`. Hall displays therefore see the same row order as the
operator UI.

The live `event.matches` array is unchanged — it continues to hold
only the matches that are currently on a court. A match in
`upcoming_matches` will move into `event.matches` when it starts
being played and disappear from `upcoming_matches` at that moment.

The field is always present (even as `[]`) for shape stability. A
receiver can iterate it unconditionally.
