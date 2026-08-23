const fs = require('fs');
let code = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');

const targetStr = `			if (batchIndex < revealBatches.length - 1) {
				const plan = getLargeNodeRevealBatchPlan(hiddenIds.length, layoutNodes.length);`;

const replacementStr = `			if (batchIndex < revealBatches.length - 1) {
				const plan = getLargeNodeRevealBatchPlan(hiddenIds.length, layoutNodes.length);
				setTimeout(
					() => {
						if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
							window.requestAnimationFrame(() => revealNextBatch(batchIndex + 1));
						} else {
							revealNextBatch(batchIndex + 1);
						}
					},
					revealBatches.length > 1 ? Math.max(16, plan.batchDelayMs) : 0,
				);
				return;
			}
			
			// Final batch finished! If the graph is huge, use WASM to compute final positions instantly!
			if (layoutNodes.length > 500) {
				simulation.stop();
				const main = document.getElementById('fg-main');
				const W = main ? main.clientWidth : 800;
				const H = main ? main.clientHeight : 600;
				const nodesPayload = layoutNodes.map((n) => ({ id: n.id, x: n.x, y: n.y, group: n.group, _deg: n._deg }));
				const linksPayload = layoutLinks.map((l) => ({ source: l.source?.id || l.source, target: l.target?.id || l.target }));
				import('@/lib/graphLayoutWorker').then(mod => {
					const createWorker = mod.default || mod.createGraphLayoutWorker;
					if (typeof createWorker === 'function') {
						const { compute } = createWorker();
						compute(nodesPayload, linksPayload, W, H).then(positions => {
							if (Array.isArray(positions)) {
								const posMap = new Map(positions.map((p) => [String(p.id), p]));
								for (const ln of layoutNodes) {
									const p = posMap.get(String(ln.id));
									if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
										ln.x = p.x;
										ln.y = p.y;
									}
								}
								refreshNodeLayout(); // Animate gently into WASM positions
							}
						}).catch(e => console.error("WASM compute failed", e));
					}
				});
			}

			try {
				saveSession();
			} catch (e) {
				/* ignore */
			}`;

const originalBlock = `			if (batchIndex < revealBatches.length - 1) {
				const plan = getLargeNodeRevealBatchPlan(hiddenIds.length, layoutNodes.length);
				setTimeout(
					() => {
						if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
							window.requestAnimationFrame(() => revealNextBatch(batchIndex + 1));
						} else {
							revealNextBatch(batchIndex + 1);
						}
					},
					revealBatches.length > 1 ? Math.max(16, plan.batchDelayMs) : 0,
				);
				return;
			}

			try {
				saveSession();
			} catch (e) {
				/* ignore */
			}`;

code = code.replace(originalBlock, replacementStr);
fs.writeFileSync('src/lib/finra-graph.ts', code);
