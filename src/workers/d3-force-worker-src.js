import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'd3-force';

let nodes = [];
let links = [];
let sim = null;

function toPositions() {
	return nodes.map(function (n) {
		return { id: n.id, x: n.x, y: n.y };
	});
}

onmessage = function (e) {
	const m = e.data || {};
	if (m.type === 'init') {
		nodes = (m.nodes || []).map(function (n) {
			return { id: n.id, x: n.x || 0, y: n.y || 0 };
		});
		links = (m.links || []).map(function (l) {
			return { source: l.source, target: l.target };
		});
		const width = m.width || 800;
		const height = m.height || 600;

		try {
			sim = forceSimulation(nodes)
				.force(
					'link',
					forceLink(links)
						.id(function (d) {
							return d.id;
						})
						.distance(70)
						.strength(0.75),
				)
				.force('charge', forceManyBody().strength(-150).theta(0.9))
				.force('center', forceCenter(width / 2, height / 2))
				.force(
					'collision',
					forceCollide()
						.radius(function (d) {
							return (d.r || 7) + 2;
						})
						.strength(1),
				)
				.velocityDecay(0.72)
				.alphaDecay(0.05)
				.on('tick', function () {
					postMessage({ type: 'tick', nodes: toPositions() });
				});
			postMessage({ type: 'ready' });
		} catch (err) {
			postMessage({ type: 'error', error: String(err) });
		}
	} else if (m.type === 'start') {
		if (sim) sim.alpha(1).restart();
	} else if (m.type === 'stop') {
		if (sim) sim.stop();
	} else if (m.type === 'updateNodes') {
		const positions = m.positions || [];
		for (const p of positions) {
			const n = nodes.find(function (x) {
				return String(x.id) === String(p.id);
			});
			if (n) {
				n.x = p.x;
				n.y = p.y;
			}
		}
	}
};
