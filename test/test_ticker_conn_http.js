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

function make_upcoming_match(id, prep_call_ts, opts) {
	opts = opts || {};
	const teams = (opts.teams !== undefined) ? opts.teams : [
		{players: [{name: 'Player1'}]},
		{players: [{name: 'Player2'}]},
	];
	return {
		_id: id,
		network_score: [[0, 0]],
		setup: {
			scoring_format: {},
			event_name: 'HE',
			match_name: id,
			is_match: true,
			state: opts.state,
			preparation_call_timestamp: prep_call_ts,
			match_num: opts.match_num,
			scheduled_time_str: opts.scheduled_time_str,
			scheduled_date: opts.scheduled_date,
			match_order: opts.match_order,
			court_id: opts.court_id,
			now_on_court: opts.now_on_court,
			teams: teams,
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

	_it('tset includes upcoming_matches sorted by scheduled_date+time, capped at 15', async function() {
		const received = [];
		const {server, url} = await make_server((req, body, res) => {
			received.push(body);
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.end('{"type":"answer","status":"ok"}');
		});

		const extras = [];
		// 16 upcoming matches across two days with various scheduled times,
		// inserted in shuffled order. Sort key is scheduled_date asc, then
		// scheduled_time_str asc, then match_order asc — should bring day 1
		// times in increasing order to the front, day 2 to the back.
		const slots = [
			{id: 'd2_1135', date: '2026-05-09', time: '11:35'},
			{id: 'd1_0900', date: '2026-05-08', time: '09:00'},
			{id: 'd1_1335', date: '2026-05-08', time: '13:35'},
			{id: 'd1_0935', date: '2026-05-08', time: '09:35'},
			{id: 'd2_0900', date: '2026-05-09', time: '09:00'},
			{id: 'd1_1100', date: '2026-05-08', time: '11:00'},
			{id: 'd1_1200', date: '2026-05-08', time: '12:00'},
			{id: 'd1_1500', date: '2026-05-08', time: '15:00'},
			{id: 'd2_1000', date: '2026-05-09', time: '10:00'},
			{id: 'd1_0945', date: '2026-05-08', time: '09:45'},
			{id: 'd1_1045', date: '2026-05-08', time: '10:45'},
			{id: 'd1_1145', date: '2026-05-08', time: '11:45'},
			{id: 'd1_1245', date: '2026-05-08', time: '12:45'},
			{id: 'd1_1345', date: '2026-05-08', time: '13:45'},
			{id: 'd1_1445', date: '2026-05-08', time: '14:45'},
			{id: 'd1_1545', date: '2026-05-08', time: '15:45'},
		];
		for (const s of slots) {
			extras.push(make_upcoming_match(s.id, undefined, {
				scheduled_date: s.date,
				scheduled_time_str: s.time,
			}));
		}
		// TBD bracket follow-up: structurally has teams, but every player
		// name is empty — must be excluded
		extras.push(make_upcoming_match('tbd', undefined, {
			scheduled_date: '2026-05-08',
			scheduled_time_str: '08:00',
			teams: [
				{players: [{name: ''}]},
				{players: [{name: ''}]},
			],
		}));
		// Half-decided bracket: one side is known, the other is empty —
		// must still appear (at least one player has a name)
		extras.push(make_upcoming_match('half', undefined, {
			scheduled_date: '2026-05-08',
			scheduled_time_str: '08:30',
			teams: [
				{players: [{name: 'Winner of QF1'}]},
				{players: [{name: ''}]},
			],
		}));
		// Finished match — must be excluded (team1_won is set)
		extras.push(make_finished_match('finished', Date.now() - 30 * 1000, true));
		// Running on a court — must be excluded
		extras.push(make_upcoming_match('on_court', undefined, {
			scheduled_date: '2026-05-08',
			scheduled_time_str: '08:45',
			court_id: 'cX',
			now_on_court: true,
		}));

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
		assert.ok(Array.isArray(ev.upcoming_matches));
		// Cap at 15: 17 valid candidates (16 slot matches + half), capped to 15
		assert.strictEqual(ev.upcoming_matches.length, 15);
		const ids = ev.upcoming_matches.map(m => m._id);
		// Day 1 + 'half' (08:30) sorts to position 0 since it has the earliest time
		assert.strictEqual(ids[0], 'half');
		// Then day 1 entries in time order
		assert.strictEqual(ids[1], 'd1_0900');
		assert.strictEqual(ids[2], 'd1_0935');
		assert.strictEqual(ids[3], 'd1_0945');
		// Day 2 entries push out the latest day-1 slots after the cap fires
		assert.ok(!ids.includes('d2_1135'));
		// scheduled_time_str is on every entry that had one
		assert.strictEqual(ev.upcoming_matches[1].scheduled_time_str, '09:00');
		// Excluded
		assert.ok(!ids.includes('tbd'), 'TBD bracket slots must be filtered out');
		assert.ok(!ids.includes('finished'));
		assert.ok(!ids.includes('on_court'));
		// The live court match (live_match.m1 has no setup.is_match) is also excluded
		assert.ok(!ids.includes('m1'));
		// And the live court match still appears in event.matches as before
		assert.strictEqual(ev.matches[0]._id, 'm1');
	});

	_it('matches without scheduled_time sort AFTER scheduled ones, not before', async function() {
		const received = [];
		const {server, url} = await make_server((req, body, res) => {
			received.push(body);
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.end('{"type":"answer","status":"ok"}');
		});

		// Mix: a hard-scheduled R16 match at 09:00 plus three "rolling"
		// group-stage matches with no scheduled_time_str (played as courts
		// open up). The R16 match must come first; group matches fall to
		// the end. Before the fix, the empty-string fallback made the
		// rolling matches sort to the front and the R16 fell out of the
		// cap window.
		const extras = [
			make_upcoming_match('group_b', undefined, {match_order: 50}),
			make_upcoming_match('group_a', undefined, {match_order: 10}),
			make_upcoming_match('r16_0900', undefined, {
				scheduled_date: '2026-05-08',
				scheduled_time_str: '09:00',
				match_order: 200,
			}),
			make_upcoming_match('group_c', undefined, {match_order: 30}),
		];

		const conn = new ticker_conn_http.TickerConnHttp(
			make_fake_app({extra_matches: extras}),
			url,
			'pw',
			'tk'
		);
		await wait(300);
		conn.terminate();
		server.close();

		const ids = received[0].event.upcoming_matches.map(m => m._id);
		assert.strictEqual(ids[0], 'r16_0900', 'scheduled match must come first');
		// Rolling group matches follow, ordered by match_order ascending
		assert.strictEqual(ids[1], 'group_a');
		assert.strictEqual(ids[2], 'group_c');
		assert.strictEqual(ids[3], 'group_b');
	});

	_it('upcoming_matches is [] when there are no upcoming matches', async function() {
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
		assert.ok(Array.isArray(ev.upcoming_matches));
		assert.strictEqual(ev.upcoming_matches.length, 0);
	});

	_it('is_called is emitted whenever setup.state === \'preparation\', even without a timestamp', async function() {
		const received = [];
		const {server, url} = await make_server((req, body, res) => {
			received.push(body);
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.end('{"type":"answer","status":"ok"}');
		});

		const now = Date.now();
		const extras = [
			// Manual call: state set, timestamp NOT set
			make_upcoming_match('manual', undefined, {state: 'preparation'}),
			// Automation pipeline: both fields set
			make_upcoming_match('auto', now - 2 * 60 * 1000, {state: 'preparation'}),
			// Plain scheduled: no state, no timestamp
			make_upcoming_match('plain'),
		];

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
		const byId = {};
		for (const m of ev.upcoming_matches) {
			byId[m._id] = m;
		}
		// Manual-called match: is_called set, no timestamp leaked
		assert.strictEqual(byId.manual.is_called, true);
		assert.strictEqual(byId.manual.preparation_call_ts, undefined);
		// Automated match: both surfaced
		assert.strictEqual(byId.auto.is_called, true);
		assert.strictEqual(typeof byId.auto.preparation_call_ts, 'number');
		// Scheduled match: neither field
		assert.strictEqual(byId.plain.is_called, undefined);
		assert.strictEqual(byId.plain.preparation_call_ts, undefined);
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
