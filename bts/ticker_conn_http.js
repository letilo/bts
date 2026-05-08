'use strict';

// HTTP(S) variant of TickerConn.
//
// Kept API-compatible with ./ticker_conn so ticker_manager can swap
// implementations based on the URL scheme of tournament.ticker_url:
//   - ws://  / wss:// -> ticker_conn.TickerConn   (persistent WebSocket)
//   - http:// / https:// -> ticker_conn_http.TickerConnHttp  (POST per message)
//
// Why this exists: some ticker receivers live on a plain PHP/Apache host
// that cannot run a persistent WebSocket server (shared hosting without
// long-lived processes). An HTTP POST endpoint is trivial to host there.
// The payload schema and semantics are identical to the WebSocket version
// ('tset' snapshot + 'tupdate_match' incremental), only the transport
// changes.

const assert = require('assert');
const http = require('http');
const https = require('https');
const url_module = require('url');

const utils = require('./utils');
const serror = require('./serror');
const fs = require('fs').promises;
const path = require('path');

const RETRY_INITIAL_MS = 1000;
const RETRY_MAX_MS = 30000;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_QUEUE_LENGTH = 200;

// How many recently-finished matches to include in each tset snapshot
// and how far back to look. Tournaments can end 200+ matches in a
// session, but viewers only care about the last handful.
const RECENT_FINISHED_LIMIT = 10;
const RECENT_FINISHED_WINDOW_MS = 4 * 60 * 60 * 1000;

// How many upcoming matches to include in each tset snapshot. Matches
// the default of BTS' own "Next Matches" view (curt.upcoming_matches_max_count = 15),
// which has already proved out as a screen-readable count on hall
// displays.
const UPCOMING_LIMIT = 15;

function craft_court(c) {
	return utils.pluck(c, ['num', 'match_id', '_id']);
}

function craft_match(m) {
	const res = utils.pluck(m, ['_id']);
	res.s = m.network_score;
	res.sf = m.setup.scoring_format;
	res.n = m.setup.event_name + ' ' + m.setup.match_name;
	m.setup.teams.forEach((t, tidx) => {
		res['p' + tidx] = t.players.map(p => p.name);
		// Parallel arrays aligned one-to-one with `p{tidx}`. Kept as
		// separate flat arrays (instead of turning `p{tidx}` into an array
		// of objects) to stay backward compatible with existing ticker
		// receivers that only look at the name arrays. Entries are null
		// when the player object has no value for that field — downstream
		// consumers must cope with nulls.
		res['p' + tidx + '_member_ids'] = t.players.map(p => p.member_id || null);
		// ISO 3-letter country code (e.g. "GER", "FRA", "JPN"), lets a
		// downstream viewer render a flag even when the local member_id
		// lookup yields nothing — relevant for international tournaments.
		res['p' + tidx + '_nationalities'] = t.players.map(p => p.nationality || null);
	});
	// Optional end/winner info — only present for finished matches. Running
	// matches leave these as undefined and JSON.stringify drops them, so
	// receivers see `end_ts` / `team1_won` only in the recent_finished_matches
	// array and never on live courts.
	if (m.end_ts) {
		res.end_ts = m.end_ts;
	}
	if (m.team1_won !== undefined && m.team1_won !== null) {
		res.team1_won = m.team1_won;
	}
	// Optional preparation info — only present for matches that have
	// been called into preparation, plus the BTP match number when set.
	// JSON.stringify drops undefined, so receivers see these fields only
	// on entries inside `upcoming_matches` (and never on running courts,
	// which never carry a preparation_call_timestamp).
	if (m.setup && Number.isFinite(Number(m.setup.preparation_call_timestamp))) {
		res.preparation_call_ts = Number(m.setup.preparation_call_timestamp);
	}
	if (m.setup && m.setup.match_num) {
		res.match_num = m.setup.match_num;
	}
	// Manual calls in BTS may set setup.state to 'preparation' without
	// also setting preparation_call_timestamp — only the automation
	// pipeline writes the timestamp (see add_preparation_call_timestamp
	// in bts/match_utils.js). Surface the state as a separate boolean
	// so a receiver can recognize "called into preparation" in either
	// pathway without depending on the timestamp being present.
	if (m.setup && m.setup.state === 'preparation') {
		res.is_called = true;
	}
	// Scheduled date/time of the match. Lets a receiver render the
	// printed-schedule time next to the match (e.g. "09:35 — HE A")
	// and is the primary sort key for upcoming_matches. Strings are
	// zero-padded by btp_sync (`time_str(...)`), which matches the
	// lexicographic ordering NeDB uses in BTS' own queries.
	if (m.setup && m.setup.scheduled_time_str) {
		res.scheduled_time_str = m.setup.scheduled_time_str;
	}
	if (m.setup && m.setup.scheduled_date) {
		res.scheduled_date = m.setup.scheduled_date;
	}
	return res;
}

// Pick the last N matches that have a non-null team1_won and ended
// within the configured lookback window. Sorted newest-first so a
// viewer can iterate straight into a "last finished" panel without
// another sort pass.
function pick_recent_finished(db_matches, now) {
	const cutoff = now - RECENT_FINISHED_WINDOW_MS;
	const finished = [];
	for (const m of db_matches) {
		if (!m.end_ts) continue;
		if (m.team1_won === undefined || m.team1_won === null) continue;
		if (m.end_ts < cutoff) continue;
		finished.push(m);
	}
	finished.sort((a, b) => b.end_ts - a.end_ts);
	if (finished.length > RECENT_FINISHED_LIMIT) {
		finished.length = RECENT_FINISHED_LIMIT;
	}
	return finished;
}

// True when at least one team has a player with a name. Used to skip
// bracket follow-up matches whose participants are not yet decided
// — those have setup.teams populated structurally but every player
// name is empty/missing. Surfacing them on a hall display would just
// fill the screen with "TBD vs TBD" rows ahead of the actually-next
// matches.
function has_at_least_one_player(m) {
	if (!m.setup || !Array.isArray(m.setup.teams)) return false;
	for (const team of m.setup.teams) {
		if (!team || !Array.isArray(team.players)) continue;
		for (const p of team.players) {
			if (p && p.name) return true;
		}
	}
	return false;
}

// Mirrors `calc_section(m) === 'unassigned'` from static/js/cmatch.js
// — a match is "upcoming" when it is neither finished nor currently
// being played on a court. The setup.is_match guard skips placeholder
// rows that the BTP import surfaces but that aren't actual matches,
// and the player-presence guard skips bracket slots whose participants
// haven't been resolved yet.
function is_upcoming(m) {
	if (!m.setup) return false;
	if (!m.setup.is_match) return false;
	if (typeof m.team1_won === 'boolean') return false;
	if (m.setup.court_id && m.setup.now_on_court) return false;
	if (!has_at_least_one_player(m)) return false;
	return true;
}

// Pick matches that are upcoming. Sort matches BTS' own NeDB query
// from match_utils.js does (sort: scheduled_date asc,
// scheduled_time_str asc, match_order asc) so the wire output mirrors
// what an operator sees in the umpire UI. Strings are zero-padded by
// the BTP import, so lexicographic comparison gives the right order.
function pick_upcoming(db_matches) {
	const upcoming = db_matches.filter(is_upcoming);
	upcoming.sort((a, b) => {
		const da = a.setup.scheduled_date || '';
		const db_ = b.setup.scheduled_date || '';
		if (da !== db_) return da < db_ ? -1 : 1;
		const ta = a.setup.scheduled_time_str || '';
		const tb = b.setup.scheduled_time_str || '';
		if (ta !== tb) return ta < tb ? -1 : 1;
		const oa = a.setup.match_order != null ? a.setup.match_order : 0;
		const ob = b.setup.match_order != null ? b.setup.match_order : 0;
		return oa - ob;
	});
	if (upcoming.length > UPCOMING_LIMIT) {
		upcoming.length = UPCOMING_LIMIT;
	}
	return upcoming;
}

class TickerConnHttp {
	constructor(app, url, password, tournament_key) {
		assert(tournament_key);
		this.app = app;
		this.last_status = 'Active';
		this.url = url;
		this.password = password;
		this.tournament_key = tournament_key;
		this.terminated = false;

		this.queue = [];
		this.in_flight = false;
		this.retry_ms = RETRY_INITIAL_MS;
		this.retry_timer = null;
		this.rid_counter = 0;

		this.parsed_url = null;
		try {
			this.parsed_url = new url_module.URL(url);
		} catch (e) {
			this.report_status('error', 'Ungültige Ticker-URL: ' + JSON.stringify(url));
			return;
		}

		if (!/^\/.*update/.test(this.parsed_url.pathname)) {
			this.report_status('error', 'Ticker-URL muss auf /update enden: ' + JSON.stringify(url));
			return;
		}

		this.report_status('connecting', 'Sende initialen Snapshot ...');
		this.pushall();
	}

	terminate() {
		this.terminated = true;
		this.queue = [];
		if (this.retry_timer) {
			clearTimeout(this.retry_timer);
			this.retry_timer = null;
		}
		this.report_status('deactivated');
	}

	pushall() {
		if (this.terminated) {
			return;
		}
		this._craft_event((err, event) => {
			if (err) {
				serror.silent('Failed to craft event: ' + err.message + ' ' + err.stack);
				this.report_status('error', 'Failed to craft data');
				return;
			}

			this._enqueue({
				type: 'tset',
				event,
			});
		});
	}

	update_score(match) {
		this._enqueue({
			type: 'tupdate_match',
			match: {
				_id: match._id,
				s: match.network_score,
			},
		});
	}

	_enqueue(msg) {
		if (this.terminated) {
			return;
		}

		// Collapse duplicate snapshots: if a pending tset exists, replace it
		// instead of sending two in sequence. For tupdate_match on the same
		// match id, keep only the newest — older scores are irrelevant.
		if (msg.type === 'tset') {
			this.queue = this.queue.filter(m => m.type !== 'tset');
		} else if (msg.type === 'tupdate_match') {
			this.queue = this.queue.filter(
				m => !(m.type === 'tupdate_match' && m.match && m.match._id === msg.match._id)
			);
		}

		msg.rid = ++this.rid_counter;
		this.queue.push(msg);

		if (this.queue.length > MAX_QUEUE_LENGTH) {
			// Drop oldest non-tset messages first to stay bounded.
			const dropped = this.queue.shift();
			serror.silent('Ticker HTTP queue overflow, dropping ' + dropped.type);
		}

		this._drain();
	}

	_drain() {
		if (this.terminated || this.in_flight || this.queue.length === 0) {
			return;
		}
		if (this.retry_timer) {
			// A reconnect backoff is pending — let it fire the next attempt.
			return;
		}

		const msg = this.queue[0];
		this.in_flight = true;
		this._post(msg, (err, response) => {
			this.in_flight = false;
			if (this.terminated) {
				return;
			}

			if (err) {
				this.report_status('error', 'Verbindung verloren, versuche erneut ... (' + err.message + ')');
				this._schedule_retry();
				return;
			}

			// Success: remove from queue, reset backoff, drain next.
			this.queue.shift();
			this.retry_ms = RETRY_INITIAL_MS;
			this.report_status('connected', '');

			if (response && response.type === 'error') {
				// Server accepted the POST but rejected the payload.
				// Don't retry a rejected message — it won't get better.
				serror.silent('Ticker HTTP server rejected message: ' + (response.message || 'unknown'));
				this.report_status('error', response.message || 'Server rejected message');
			}

			this._drain();
		});
	}

	_schedule_retry() {
		if (this.terminated) {
			return;
		}
		if (this.retry_timer) {
			return;
		}
		const delay = this.retry_ms;
		this.retry_ms = Math.min(this.retry_ms * 2, RETRY_MAX_MS);
		this.retry_timer = setTimeout(() => {
			this.retry_timer = null;
			this._drain();
		}, delay);
	}

	_post(msg, cb) {
		if (!this.parsed_url) {
			return cb(new Error('invalid url'));
		}

		const body = JSON.stringify(msg);
		const is_https = this.parsed_url.protocol === 'https:';
		const lib = is_https ? https : http;

		const options = {
			method: 'POST',
			hostname: this.parsed_url.hostname,
			port: this.parsed_url.port || (is_https ? 443 : 80),
			path: this.parsed_url.pathname + this.parsed_url.search,
			timeout: REQUEST_TIMEOUT_MS,
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body),
				'Authorization': 'Bearer ' + this.password,
				'User-Agent': 'bts-ticker-http/1.0',
				'Accept': 'application/json',
			},
		};

		let done = false;
		const finish = (err, result) => {
			if (done) return;
			done = true;
			cb(err, result);
		};

		const req = lib.request(options, (res) => {
			let chunks = '';
			res.setEncoding('utf8');
			res.on('data', (c) => {
				chunks += c;
				if (chunks.length > 64 * 1024) {
					req.destroy(new Error('response too large'));
				}
			});
			res.on('end', () => {
				if (res.statusCode >= 200 && res.statusCode < 300) {
					let parsed = null;
					if (chunks.length > 0) {
						try {
							parsed = JSON.parse(chunks);
						} catch (e) {
							// Empty / non-JSON 2xx is acceptable.
						}
					}
					return finish(null, parsed);
				}
				return finish(new Error('HTTP ' + res.statusCode + (chunks ? ': ' + chunks.slice(0, 200) : '')));
			});
		});

		req.on('error', (err) => finish(err));
		req.on('timeout', () => {
			req.destroy(new Error('request timeout'));
		});

		req.write(body);
		req.end();
	}

	report_status(status, message) {
		const msg = {
			status: status,
			message: message,
		};
		this.last_status = msg;
		const admin = require('./admin');
		admin.notify_change(this.app, this.tournament_key, 'ticker_status', msg);
	}

	_craft_event(cb) {
		const tournament_key = this.tournament_key;

		this.app.db.fetch_all([{
			collection: 'courts',
			query: {tournament_key},
		}, {
			collection: 'matches',
			query: {tournament_key},
		}, {
			collection: 'tournaments',
			query: {key: tournament_key},
		}], (err, db_courts, db_matches, db_tournaments) => {
			if (err) return cb(err);

			const interesting_ids = utils.filter_map(db_courts, c => c.match_id);
			const interesting_matches = db_matches.filter(m => interesting_ids.includes(m._id));

			const matches_by_id = new Map();
			for (const m of interesting_matches) {
				matches_by_id.set(m._id, m);
			}

			const now = Date.now();
			for (const c of db_courts) {
				const m = matches_by_id.get(c.match_id);
				if (!m) continue;
				if (!m.end_ts) continue;

				if (m.end_ts < now - 15 * 60 * 1000) {
					c.match_id = null;
				}
			}

			// Base fields that don't depend on tournament metadata. Built
			// once and spread into whichever branch we take below.
			const base = {
				courts: db_courts.map(craft_court),
				matches: interesting_matches.map(craft_match),
				recent_finished_matches: pick_recent_finished(db_matches, now).map(craft_match),
				upcoming_matches: pick_upcoming(db_matches).map(craft_match),
			};

			if (db_tournaments && db_tournaments.length == 1) {
				const tournament = db_tournaments[0];
				const tname = tournament.name;
				const turl = 'https://' + ((tournament.btp_settings && tournament.btp_settings.tournament_urn) ? tournament.btp_settings.tournament_urn : 'www.turnier.de') + '/tournament' + (tournament.tguid ? '/' + tournament.tguid + '/matches' : 's/');
				if (tournament.logo_id && tournament.logo_id != null) {
					const file_path = path.join(utils.root_dir(), 'data', 'logos', tournament.logo_id);
					fs.readFile(file_path)
						.then((file_buffer) => {
							const base64_image = file_buffer.toString('base64');
							const filetype = tournament.logo_id.split('.')[1];
							const mime = {
								gif: 'image/gif',
								png: 'image/png',
								jpg: 'image/jpeg',
								jpeg: 'image/jpeg',
								svg: 'image/svg+xml',
								webp: 'image/webp',
							}[filetype];

							return cb(null, Object.assign({}, base, {
								tournament_name: tname,
								tournament_url: turl,
								tournament_logo: base64_image,
								tournament_logo_mime: mime,
								tournament_logo_background_color: tournament.logo_background_color,
							}));
						})
						.catch(() => {
							return cb(null, Object.assign({}, base, {
								tournament_name: tname,
								tournament_url: turl,
							}));
						});
				} else {
					return cb(null, Object.assign({}, base, {
						tournament_name: tname,
						tournament_url: turl,
					}));
				}
			} else {
				return cb(null, Object.assign({}, base, {
					tournament_name: '',
					tournament_url: '',
				}));
			}
		});
	}
}

module.exports = {
	TickerConnHttp,
};
