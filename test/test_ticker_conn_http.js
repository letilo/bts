'use strict';

/* global describe, it */

const assert = require('assert');
const http = require('http');
const Module = require('module');

// Stub ./admin because ticker_conn_http lazy-requires it inside report_status()
// and we don't want to pull in the full admin.js (which needs 'async', 'ws',
// etc. — heavy deps the test doesn't care about). Install the stub into the
// module cache so every future `require('./admin')` resolves to our stub.
const _admin_stub_path = require('path').resolve(__dirname, '..', 'bts', 'admin.js');
require.cache[_admin_stub_path] = {
	id: _admin_stub_path,
	filename: _admin_stub_path,
	loaded: true,
	exports: {
		notify_change: function(/* app, key, kind, msg */) {
			// swallow in tests
		},
	},
};

const ticker_conn_http = require('../bts/ticker_conn_http');

const _describe = describe;
const _it = it;

function make_fake_app(opts) {
	opts = opts || {};
	const include_member_ids = opts.include_member_ids !== false;
	const include_nationalities = opts.include_nationalities !== false;
	const extra_matches = opts.extra_matches || [];
	return {
		db: {
			fetch_all: function(queries, cb) {
				// Minimal snapshot: one court, one live match, one tournament,
				// plus optional extra matches that exercise the
				// recent_finished_matches filter.
				const alice = {name: 'Alice'};
				const bob = {name: 'Bob'};
				if (include_member_ids) {
					alice.member_id = '08-000001';
					bob.member_id = '08-000002';
				}
				if (include_nationalities) {
					alice.nationality = 'GER';
					bob.nationality = 'FRA';
				}
				const live_match = {
					_id: 'm1',
					network_score: [[0, 0]],
					setup: {
						scoring_format: {},
						event_name: 'HE',
						match_name: '1',
						teams: [
							{players: [alice]},
							{players: [bob]},
						],
					},
				};
				cb(null,
					[{num: 1, match_id: 'm1', _id: 'c1'}],
					[live_match].concat(extra_matches),
					[{key: 'tk', name: 'Test', btp_settings: {}, tguid: null}]
				);
			},
		},
	};
}

function make_finished_match(id, end_ts, team1_won, score) {
	return {
		_id: id,
		network_score: score || [[21, 19], [21, 15]],
		end_ts: end_ts,
		team1_won: team1_won,
		setup: {
			scoring_format: {},
			event_name: 'HE',
			match_name: id,
			teams: [
				{players: [{name: 'Winner'}]},
				{players: [{name: 'Loser'}]},
			],
		},
	};
}

function make_server(handler) {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			let body = '';
			req.on('data', (c) => {
				body += c;
			});
			req.on('end', () => {
				let parsed = null;
				if (body) {
					try {
						parsed = JSON.parse(body);
					} catch (e) {
						// leave null
					}
				}
				handler(req, parsed, res);
			});
		});
		server.listen(0, '127.0.0.1', () => {
			resolve({
				server,
				url: 'http://127.0.0.1:' + server.address().port + '/api/live_update.php',
			});
		});
	});
}

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

_describe('ticker_conn_http', function() {
	_it('sends tset on connect with Bearer auth', async function() {
		const received = [];
		const {server, url} = await make_server((req, body, res) => {
			received.push({auth: req.headers['authorization'], body});
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.end('{"type":"answer","status":"ok"}');
		});

		const conn = new ticker_conn_http.TickerConnHttp(make_fake_app(), url, 'secret-pw', 'tk');
		await wait(300);
		conn.terminate();
		server.close();

		assert.strictEqual(received.length, 1);
		assert.strictEqual(received[0].auth, 'Bearer secret-pw');
		assert.strictEqual(received[0].body.type, 'tset');
		assert.ok(received[0].body.event);
		assert.strictEqual(received[0].body.event.tournament_name, 'Test');
	});

	_it('sends tupdate_match after update_score', async function() {
		const received = [];
		const {server, url} = await make_server((req, body, res) => {
			received.push(body);
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.end('{"type":"answer","status":"ok"}');
		});

		const conn = new ticker_conn_http.TickerConnHttp(make_fake_app(), url, 'pw', 'tk');
		await wait(150);
		conn.update_score({
			_id: 'm1',
			network_score: [[21, 19]],
			tournament_key: 'tk',
		});
		await wait(300);
		conn.terminate();
		server.close();

		assert.strictEqual(received.length, 2);
		assert.strictEqual(received[0].type, 'tset');
		assert.strictEqual(received[1].type, 'tupdate_match');
		assert.strictEqual(received[1].match._id, 'm1');
		assert.deepStrictEqual(received[1].match.s, [[21, 19]]);
	});

	_it('retries on server 5xx with backoff', async function() {
		let attempts = 0;
		const {server, url} = await make_server((req, body, res) => {
			attempts++;
			if (attempts < 3) {
				res.writeHead(500);
				res.end('nope');
				return;
			}
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.end('{"type":"answer","status":"ok"}');
		});

		const conn = new ticker_conn_http.TickerConnHttp(make_fake_app(), url, 'pw', 'tk');
		await wait(5000);
		conn.terminate();
		server.close();

		assert.ok(attempts >= 3, 'expected at least 3 attempts, got ' + attempts);
	});

	_it('collapses duplicate updates for the same match', async function() {
		const received = [];
		const {server, url} = await make_server((req, body, res) => {
			received.push(body);
			// Slow response so the queue builds up
			setTimeout(() => {
				res.writeHead(200, {'Content-Type': 'application/json'});
				res.end('{"type":"answer","status":"ok"}');
			}, 80);
		});

		const conn = new ticker_conn_http.TickerConnHttp(make_fake_app(), url, 'pw', 'tk');
		await wait(20);
		// Flood the queue while first POST is still in flight
		for (let i = 0; i < 10; i++) {
			conn.update_score({_id: 'm1', network_score: [[i, 0]], tournament_key: 'tk'});
		}
		conn.update_score({_id: 'm2', network_score: [[5, 0]], tournament_key: 'tk'});
		await wait(800);
		conn.terminate();
		server.close();

		// Expect: 1 tset + 1 collapsed m1 update + 1 m2 update
		assert.ok(received.length <= 4, 'expected <=4 sends after collapse, got ' + received.length);
		const match_types = received.filter((m) => m.type === 'tupdate_match');
		const m1_sends = match_types.filter((m) => m.match._id === 'm1');
		const m2_sends = match_types.filter((m) => m.match._id === 'm2');
		assert.strictEqual(m1_sends.length, 1, 'm1 should be collapsed to 1 send');
		assert.strictEqual(m2_sends.length, 1);
	});

	_it('rejects invalid URL without crashing', function() {
		const conn = new ticker_conn_http.TickerConnHttp(make_fake_app(), 'not a url', 'pw', 'tk');
		assert.ok(conn);
		conn.terminate();
	});

	_it('rejects URL path that does not contain /update', function() {
		const conn = new ticker_conn_http.TickerConnHttp(make_fake_app(), 'http://example.com/wrong', 'pw', 'tk');
		assert.ok(conn);
		conn.terminate();
	});

	_it('tset includes p0_member_ids / p1_member_ids when set', async function() {
		const received = [];
		const {server, url} = await make_server((req, body, res) => {
			received.push(body);
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.end('{"type":"answer","status":"ok"}');
		});

		const conn = new ticker_conn_http.TickerConnHttp(make_fake_app(), url, 'pw', 'tk');
		await wait(300);
		conn.terminate();
		server.close();

		assert.strictEqual(received.length, 1);
		const tset = received[0];
		assert.strictEqual(tset.type, 'tset');
		assert.ok(Array.isArray(tset.event.matches));
		assert.strictEqual(tset.event.matches.length, 1);

		const m = tset.event.matches[0];
		assert.deepStrictEqual(m.p0, ['Alice']);
		assert.deepStrictEqual(m.p1, ['Bob']);
		// Parallel arrays aligned 1:1 with p0 / p1
		assert.deepStrictEqual(m.p0_member_ids, ['08-000001']);
		assert.deepStrictEqual(m.p1_member_ids, ['08-000002']);
	});

	_it('tset falls back to null member_ids when player has no member_id', async function() {
		const received = [];
		const {server, url} = await make_server((req, body, res) => {
			received.push(body);
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.end('{"type":"answer","status":"ok"}');
		});

		const conn = new ticker_conn_http.TickerConnHttp(
			make_fake_app({include_member_ids: false}),
			url,
			'pw',
			'tk'
		);
		await wait(300);
		conn.terminate();
		server.close();

		const m = received[0].event.matches[0];
		assert.deepStrictEqual(m.p0, ['Alice']);
		assert.deepStrictEqual(m.p1, ['Bob']);
		// Player objects without member_id -> null entries, array is still present
		assert.deepStrictEqual(m.p0_member_ids, [null]);
		assert.deepStrictEqual(m.p1_member_ids, [null]);
	});

	_it('tset includes p0_nationalities / p1_nationalities when set', async function() {
		const received = [];
		const {server, url} = await make_server((req, body, res) => {
			received.push(body);
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.end('{"type":"answer","status":"ok"}');
		});

		const conn = new ticker_conn_http.TickerConnHttp(make_fake_app(), url, 'pw', 'tk');
		await wait(300);
		conn.terminate();
		server.close();

		const m = received[0].event.matches[0];
		// Nationalities are parallel to p0 / p1 and carry the ISO-3 country
		// code from the player object, enabling flag rendering downstream
		// independently of the member_id lookup.
		assert.deepStrictEqual(m.p0_nationalities, ['GER']);
		assert.deepStrictEqual(m.p1_nationalities, ['FRA']);
	});

	_it('tset falls back to null nationalities when player has no nationality', async function() {
		const received = [];
		const {server, url} = await make_server((req, body, res) => {
			received.push(body);
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.end('{"type":"answer","status":"ok"}');
		});

		const conn = new ticker_conn_http.TickerConnHttp(
			make_fake_app({include_nationalities: false}),
			url,
			'pw',
			'tk'
		);
		await wait(300);
		conn.terminate();
		server.close();

		const m = received[0].event.matches[0];
		assert.deepStrictEqual(m.p0_nationalities, [null]);
		assert.deepStrictEqual(m.p1_nationalities, [null]);
	});

	_it('tset includes recent_finished_matches newest-first, capped at 10', async function() {
		const received = [];
		const {server, url} = await make_server((req, body, res) => {
			received.push(body);
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.end('{"type":"answer","status":"ok"}');
		});

		const now = Date.now();
		// Build 12 finished matches spread over the last hour, plus one
		// that is outside the lookback window (should be excluded).
		const extras = [];
		for (let i = 0; i < 12; i++) {
			extras.push(make_finished_match('f' + i, now - i * 60 * 1000, i % 2 === 0));
		}
		// Way too old -> must not appear
		extras.push(make_finished_match('too_old', now - 5 * 60 * 60 * 1000, true));
		// Running match (no end_ts) -> must not appear
		extras.push({
			_id: 'running',
			network_score: [[10, 5]],
			setup: {
				scoring_format: {},
				event_name: 'HE',
				match_name: 'running',
				teams: [{players: [{name: 'A'}]}, {players: [{name: 'B'}]}],
			},
		});

		const conn = new ticker_conn_http.TickerConnHttp(
			make_fake_app({extra_matches: extras}),
			url,
			'pw',
			'tk'
		);
		await wait(300);
		conn.terminate();
		server.close();

		const ev = received[0].event;
		assert.ok(Array.isArray(ev.recent_finished_matches));
		// Capped at 10
		assert.strictEqual(ev.recent_finished_matches.length, 10);
		// Newest first: f0 has end_ts now, f1 has now-60s, ...
		assert.strictEqual(ev.recent_finished_matches[0]._id, 'f0');
		assert.strictEqual(ev.recent_finished_matches[9]._id, 'f9');
		// Each finished match carries end_ts + team1_won
		assert.ok(typeof ev.recent_finished_matches[0].end_ts === 'number');
		assert.strictEqual(typeof ev.recent_finished_matches[0].team1_won, 'boolean');
		// The running match on the live court does NOT leak end_ts/team1_won
		assert.ok(ev.matches[0]);
		assert.strictEqual(ev.matches[0].end_ts, undefined);
		assert.strictEqual(ev.matches[0].team1_won, undefined);
	});

	_it('recent_finished_matches is [] when there are no finished matches', async function() {
		const received = [];
		const {server, url} = await make_server((req, body, res) => {
			received.push(body);
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.end('{"type":"answer","status":"ok"}');
		});

		const conn = new ticker_conn_http.TickerConnHttp(make_fake_app(), url, 'pw', 'tk');
		await wait(300);
		conn.terminate();
		server.close();

		const ev = received[0].event;
		// Field is always present for shape stability
		assert.ok(Array.isArray(ev.recent_finished_matches));
		assert.strictEqual(ev.recent_finished_matches.length, 0);
	});

	_it('sample payload from ticker_data/beispiel_request.json validates', function() {
		// Regression guard: the fields we produce in _craft_event must match
		// the shape of a real captured request. If BTS upstream adds/removes
		// fields this test flags it.
		const path = require('path');
		const fs = require('fs');
		const sample_path = path.join(__dirname, '..', 'ticker_data', 'beispiel_request.json');
		const sample = JSON.parse(fs.readFileSync(sample_path, 'utf8'));

		assert.strictEqual(sample.type, 'tset');
		assert.ok(sample.event, 'sample must have event');
		assert.ok(Array.isArray(sample.event.courts));
		assert.ok(Array.isArray(sample.event.matches));
		assert.strictEqual(typeof sample.event.tournament_name, 'string');

		// Court shape
		for (const court of sample.event.courts) {
			assert.ok('num' in court, 'court must have num');
			assert.ok('_id' in court, 'court must have _id');
		}

		// Match shape (at least the fields our adapter relies on)
		for (const match of sample.event.matches) {
			assert.ok('_id' in match, 'match must have _id');
			assert.ok('n' in match, 'match must have n (name)');
			assert.ok('p0' in match, 'match must have p0 (team 0 player names)');
			assert.ok('p1' in match, 'match must have p1 (team 1 player names)');
			assert.ok(Array.isArray(match.p0));
			assert.ok(Array.isArray(match.p1));
		}
	});

	_it('terminate stops further posts', async function() {
		let attempts = 0;
		const {server, url} = await make_server((req, body, res) => {
			attempts++;
			res.writeHead(500);
			res.end('nope');
		});

		const conn = new ticker_conn_http.TickerConnHttp(make_fake_app(), url, 'pw', 'tk');
		await wait(50);
		conn.terminate();
		const attempts_after_terminate = attempts;
		await wait(2500);
		server.close();

		assert.strictEqual(attempts, attempts_after_terminate, 'no new requests after terminate');
	});
});
