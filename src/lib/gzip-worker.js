/* eslint-disable @typescript-eslint/no-require-imports */
const { parentPort } = require('worker_threads');
const { gzip, gunzip } = require('zlib');

function gzipAsync(buf) {
	return new Promise((resolve, reject) => gzip(buf, (err, res) => (err ? reject(err) : resolve(res))));
}

function gunzipAsync(buf) {
	return new Promise((resolve, reject) => gunzip(buf, (err, res) => (err ? reject(err) : resolve(res))));
}

parentPort.on('message', async (msg) => {
	const { id, action, payload } = msg || {};
	try {
		if (action === 'gzip') {
			const buf = Buffer.from(payload, 'utf-8');
			const gz = await gzipAsync(buf);
			parentPort.postMessage({ id, ok: true, result: gz.toString('base64') });
		} else if (action === 'gunzip') {
			const buf = Buffer.from(payload, 'base64');
			const out = await gunzipAsync(buf);
			parentPort.postMessage({ id, ok: true, result: out.toString('utf-8') });
		} else {
			parentPort.postMessage({ id, ok: false, error: 'unknown action' });
		}
	} catch (e) {
		parentPort.postMessage({ id, ok: false, error: String(e) });
	}
});
