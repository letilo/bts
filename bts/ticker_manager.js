'use strict';

const assert = require('assert');

const ticker_conn = require('./ticker_conn');
const ticker_conn_http = require('./ticker_conn_http');


const conns_by_tkey = new Map();

// Pick the transport implementation based on the URL scheme configured on
// the tournament. ws:// / wss:// keeps the original persistent WebSocket;
// http:// / https:// uses the HTTP-POST adapter for receivers that can't
// host a long-lived WebSocket server (e.g. plain PHP/Apache shared hosting).
function _create_conn(app, t) {
	const url = t.ticker_url || '';
	if (/^https?:\/\//i.test(url)) {
		return new ticker_conn_http.TickerConnHttp(app, url, t.ticker_password, t.key);
	}
	return new ticker_conn.TickerConn(app, url, t.ticker_password, t.key);
}

function reconfigure(app, t) {
	const cur_conn = conns_by_tkey.get(t.key);
	if (cur_conn) {
		cur_conn.terminate();
	}

	if (! t.ticker_enabled) {
		return;
	}

	const conn = _create_conn(app, t);
	conns_by_tkey.set(t.key, conn);
}

function pushall(app, tkey) {
	assert(tkey);

	const conn = conns_by_tkey.get(tkey);
	if (!conn) {
		// Do not output an error; this happens if ticker support gets disabled
		return;
	}

	conn.pushall();
}

function reset(app, tkey) {
	assert(tkey);

	app.db.tournaments.findOne({key: tkey}, (err, tournament) => {
		if (err) return; // silent error? tournament already deleted

		reconfigure(app, tournament);
	});
}

function update_score(app, match) {
	assert(match);
	const tkey = match.tournament_key;
	assert(tkey);

	const conn = conns_by_tkey.get(tkey);
	if (!conn) {
		// Do not output an error; this happens if ticker support gets disabled
		return;
	}

	conn.update_score(match);
}

function init(app, cb) {
	app.db.tournaments.find({}, (err, tournaments) => {
		if (err) return cb(err);

		for (const t of tournaments) {
			reconfigure(app, t);
		}
		cb();
	});
}

function get_status(tkey) {
	const conn = conns_by_tkey.get(tkey);
	if (!conn) {
		return { status: 'deactivated', message: '' };
	}
	return conn.last_status;
}

module.exports = {
	get_status,
	init,
	reconfigure,
	pushall,
	update_score,
	reset,
};