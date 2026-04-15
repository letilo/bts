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
		// Parallel array of federation member IDs (e.g. "08-009763"), aligned
		// one-to-one with `p{tidx}`. Entries are null if the player object
		// has no member_id — downstream consumers must cope with nulls.
		// Kept as a separate array instead of turning `p{tidx}` into objects
		// to stay backward compatible with existing ticker receivers that
		// only look at the name arrays.
		res['p' + tidx + '_member_ids'] = t.players.map(p => p.member_id || null);
	});
	return res;
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

							return cb(null, {
								courts: db_courts.map(craft_court),
								matches: interesting_matches.map(craft_match),
								tournament_name: tname,
								tournament_url: turl,
								tournament_logo: base64_image,
								tournament_logo_mime: mime,
								tournament_logo_background_color: tournament.logo_background_color,
							});
						})
						.catch(() => {
							return cb(null, {
								courts: db_courts.map(craft_court),
								matches: interesting_matches.map(craft_match),
								tournament_name: tname,
								tournament_url: turl,
							});
						});
				} else {
					return cb(null, {
						courts: db_courts.map(craft_court),
						matches: interesting_matches.map(craft_match),
						tournament_name: tname,
						tournament_url: turl,
					});
				}
			} else {
				return cb(null, {
					courts: db_courts.map(craft_court),
					matches: interesting_matches.map(craft_match),
					tournament_name: '',
					tournament_url: '',
				});
			}
		});
	}
}

module.exports = {
	TickerConnHttp,
};
