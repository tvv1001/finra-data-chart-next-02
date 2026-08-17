/* Worker to run Rust/WASM graph layout off the main thread.
   Expects wasm-pack build output to be placed under /wasm/graph-layout/ via the repo build step.

   Message protocol:
   - postMessage({ type: 'compute', nodesJson, linksJson, width, height })
   - worker posts back: { type: 'result', positions } or { type: 'error', message }
*/

let wasmReady = false;
let compute_layout = null;

function tryImportGlue() {
	try {
		// wasm-pack outputs vary; try common names
		try {
			importScripts('/wasm/graph-layout/graph_layout.js');
		} catch (e) {
			importScripts('/wasm/graph-layout/graph-layout.js');
		}
		wasmReady = true;
		// wasm-bindgen usually exposes init and exported functions on the global scope
		// graph_layout is the module name for crate 'graph-layout' compiled by wasm-pack
		if (typeof graph_layout !== 'undefined' && graph_layout.compute_layout) {
			compute_layout = graph_layout.compute_layout;
		} else if (typeof wasm_bindgen !== 'undefined' && wasm_bindgen.compute_layout) {
			compute_layout = wasm_bindgen.compute_layout;
		}
	} catch (err) {
		postMessage({ type: 'error', message: 'Failed to load WASM glue: ' + String(err) });
	}
}

tryImportGlue();

onmessage = async (ev) => {
	const msg = ev.data || {};
	if (msg && msg.type === 'compute') {
		if (!compute_layout) {
			postMessage({ type: 'error', message: 'WASM compute_layout not available' });
			return;
		}
		try {
			const res = await compute_layout(msg.nodesJson, msg.linksJson, msg.width || 800, msg.height || 600);
			// result is JSON string of positions
			let positions = [];
			try {
				positions = JSON.parse(res);
			} catch (e) {
				positions = res;
			}
			postMessage({ type: 'result', positions });
		} catch (e) {
			postMessage({ type: 'error', message: String(e) });
		}
	}
};
