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

## Ticker payload: player identifiers

Each match in a `tset` payload carries two kinds of player arrays, one per
team side:

- `p0` / `p1` — array of player display names (unchanged)
- `p0_member_ids` / `p1_member_ids` — parallel array of federation member
  IDs (e.g. `"08-009763"`), aligned 1:1 with `p0` / `p1`. Entries are
  `null` if the underlying player object has no `MemberID` in the BTP
  source data (common for tournaments imported without federation data).

The `_member_ids` arrays were added in a later change (see
`feat/ticker-member-ids`) and are backward compatible: receivers that only
look at `p0` / `p1` continue to work unchanged. New receivers can use
`p0_member_ids` / `p1_member_ids` to link players to an external profile
(badhub, turnier.de, etc.).

`tupdate_match` messages are unaffected — they continue to carry only
`{_id, s}` and never re-transmit player data. Player identity is
established through the surrounding `tset` snapshot.
