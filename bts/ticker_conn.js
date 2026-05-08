'use strict';

const assert = require('assert');

const ws_module = require('ws');

const utils = require('./utils');
const serror = require('./serror');
const fs = require('fs').promises;
const path = require('path');

const RECONNECT_TIMEOUT = 1000;

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

// Mirrors `calc_section(m) === 'unassigned'` from static/js/cmatch.js
// — a match is "upcoming" when it is neither finished nor currently
// being played on a court. This matches what BTS' own "Next Matches"
// view shows. The setup.is_match guard skips placeholder rows that
// the BTP import surfaces but that aren't actual matches.
function is_upcoming(m) {
	if (!m.setup) return false;
	if (!m.setup.is_match) return false;
	if (typeof m.team1_won === 'boolean') return false;
	if (m.setup.court_id && m.setup.now_on_court) return false;
	return true;
}

// Pick matches that are upcoming (not finished, not on a live court).
// Sort identical to BTS' own next-matches UI in static/js/ctournament.js
// (`get_self_check_in_matches`): ascending by preparation_call_timestamp,
// missing timestamps fall back to 0 — which keeps the BTP-import order
// stable for matches that have not been called yet.
function pick_upcoming(db_matches) {
	const upcoming = db_matches.filter(is_upcoming);
	upcoming.sort((a, b) =>
		(a.setup.preparation_call_timestamp || 0) -
		(b.setup.preparation_call_timestamp || 0));
	if (upcoming.length > UPCOMING_LIMIT) {
		upcoming.length = UPCOMING_LIMIT;
	}
	return upcoming;
}

class TickerConn {
	constructor(app, url, password, tournament_key) {
		assert(tournament_key);
		this.app = app;
		this.last_status = 'Active';
		this.url = url;
		this.password = password;
		this.tournament_key = tournament_key;
		this.terminated = false;
		this.ws = null;
		this.connect();
	}

	connect() {
		if (this.terminated) {
			return;
		}

		this.report_status('connecting','Verbindung wird hergestellt ...');
		if (!/^wss?:\/\/.*\/update/.test(this.url)) {
			this.report_status('error','Ungültige Ticker-URL: ' + JSON.stringify(this.url));
			return;
		}
		const ws_url = this.url + '?password=' + encodeURIComponent(this.password);
		const ws = new ws_module(ws_url);
		const tc = this;
		tc.ws = ws;
		ws.on('open', function() {
			tc.report_status('connected','');
			tc.pushall();
		});
		ws.on('message', function(data) {
			let msg;
			try {
				msg = JSON.parse(data);
			} catch (e) {
				tc.report_status('error', 'Failed to receive ticker message: ' + e.message);
				return;
			}
			if ((msg.type === 'error') || ((msg.type === 'dmsg') && (msg.dtype === 'error'))) {
				tc.report_status('error', msg.message);
			}
		});
		ws.on('error', function() {
			if (tc.ws !== ws) { // Terminated intentionally or as a race?
				return;
			}

			tc.on_end();
		});
		ws.on('close', function() {
			if (tc.ws !== ws) { // Terminated intentionally or as a race?
				return;
			}

			tc.on_end();
		});
	}

	terminate() {
		if (this.ws) {
			const ws = this.ws;
			this.ws = null;
			ws.close();
		}
		this.terminated = true;
		this.report_status('deactivated');
	}

	schedule_reconnect() {
		if (this.terminated) {
			return;
		}
		setTimeout(() => this.connect(), RECONNECT_TIMEOUT);
	}

	pushall() {
		this._craft_event((err, event) => {
			if (err) {
				serror.silent('Failed to craft event: ' + err.message + ' ' + err.stack);
				this.report_status('error','Failed to craft data');
				return;
			}

			this.sendmsg({
				type: 'tset',
				event,
			});
		});
	}

	update_score(match) {
		this.sendmsg({
			type: 'tupdate_match',
			match: {
				_id: match._id,
				s: match.network_score,
			},
		});
	}

	sendmsg(msg) {
		if (!this.ws) {
			return;
		}

		try {
			this.ws.send(JSON.stringify(msg));
		} catch(e) {
			serror.silent('Failed to send ticker data: ' + e.message);
		}
	}

	on_end() {
		this.ws = null;
		this.report_status('error','Verbindung verloren, versuche erneut ...');
		this.schedule_reconnect();
	}

	report_status(status, message) {
		const msg = {
			status: status,
			message: message
		}
		this.last_status = msg;
		const admin = require('./admin');
		admin.notify_change(this.app, this.tournament_key, 'ticker_status', msg);
	}

	// Create the event version to send to the ticker
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
			query: { key: tournament_key},
		}], (err, db_courts, db_matches, db_tournaments) => {
			if (err) return cb(err);

			const interesting_ids = utils.filter_map(db_courts, c => c.match_id);
			const interesting_matches = db_matches.filter(m => interesting_ids.includes(m._id));

			const matches_by_id = new Map();
			for (const m of interesting_matches) {
				matches_by_id.set(m._id, m);
			}

			// Hide old matches
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
				const turl = "https://" + ((tournament.btp_settings && tournament.btp_settings.tournament_urn) ? tournament.btp_settings.tournament_urn : "www.turnier.de") + "/tournament" + (tournament.tguid ? "/" + tournament.tguid + "/matches" : "s/");
				if (tournament.logo_id && tournament.logo_id != null) {
					const file_path = path.join(utils.root_dir(), 'data', 'logos', tournament.logo_id);
					fs.readFile(file_path)
						.then((file_buffer) => {
							const base64_image = file_buffer.toString('base64');
							const filetype = tournament.logo_id.split(".")[1];
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
						.catch((error) => {
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
					tournament_name: "",
					tournament_url: "",
				}));
			}
		});
	}

}

module.exports = {
	TickerConn,
};
