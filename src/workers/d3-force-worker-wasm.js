let nodes = [];
let links = [];
let running = false;
let width = 800;
let height = 600;
let wasmApi = null;
let tickTimer = null;

async function ensureWasm() {
	if (wasmApi) return wasmApi;
	try {
		const mod = await import('/wasm/graph-layout/graph_layout.js');
		if (typeof mod.default === 'function') {
			await mod.default();
		}
		wasmApi = mod;
		return mod;
	} catch (err) {
		console.warn('[wasm-worker] rust wasm worker unavailable, falling back to JS path', err);
		throw err;
	}
}

function postPositions() {
	if (!nodes.length) return;
	postMessage({ type: 'tick', nodes: nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })) });
}

async function stepSimulation() {
	if (!running) return;
	try {
		const mod = await ensureWasm();
		const next = JSON.parse(mod.compute_layout(JSON.stringify(nodes), JSON.stringify(links), width, height));
		const map = new Map(next.map((item) => [String(item.id), item]));
		for (const node of nodes) {
			const nextNode = map.get(String(node.id));
			if (nextNode) {
				node.x = nextNode.x;
				node.y = nextNode.y;
			}
		}
		postPositions();
	} catch (err) {
		postMessage({ type: 'error', error: String(err) });
		running = false;
		return;
	}
	if (running) {
		tickTimer = setTimeout(stepSimulation, 16);
	}
}

onmessage = async function (event) {
	const message = event.data || {};
	if (message.type === 'init') {
		nodes = (message.nodes || []).map((n) => ({
			id: n.id,
			x: Number.isFinite(n.x) ? n.x : 0,
			y: Number.isFinite(n.y) ? n.y : 0,
			locX: Number.isFinite(n.locX) ? n.locX : null,
			locY: Number.isFinite(n.locY) ? n.locY : null,
			locStrength: Number.isFinite(n.locStrength) ? n.locStrength : 0,
		}));
		links = (message.links || []).map((link) => ({ source: link.source, target: link.target }));
		width = Number.isFinite(message.width) ? message.width : width;
		height = Number.isFinite(message.height) ? message.height : height;
		postMessage({ type: 'ready' });
	} else if (message.type === 'start') {
		running = true;
		if (tickTimer) clearTimeout(tickTimer);
		stepSimulation();
	} else if (message.type === 'stop') {
		running = false;
		if (tickTimer) clearTimeout(tickTimer);
	} else if (message.type === 'updateNodes') {
		for (const p of message.positions || []) {
			const node = nodes.find((entry) => String(entry.id) === String(p.id));
			if (node) {
				node.x = Number.isFinite(p.x) ? p.x : node.x;
				node.y = Number.isFinite(p.y) ? p.y : node.y;
			}
		}
	}
};
