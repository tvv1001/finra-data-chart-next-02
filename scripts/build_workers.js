#!/usr/bin/env node
const esbuild = require('esbuild');
const { execSync } = require('child_process');
const path = require('path');

async function build() {
	if (process.env.VERCEL) {
		console.log('Running in Vercel: Skipping Rust/WASM worker build (using prebuilt or JS fallback).');
	} else {
		try {
			execSync('cd rust/graph-layout && wasm-pack build --target web --out-dir ../../public/wasm/graph-layout', {
				stdio: 'inherit',
			});
			console.log('Built Rust/WASM layout worker');
		} catch (e) {
			console.warn('Rust/WASM worker build skipped or failed. Falling back to JS worker only.', e.message || e);
		}
	}

	const entry = path.join(process.cwd(), 'src', 'workers', 'd3-force-worker-wasm.js');
	const out = path.join(process.cwd(), 'public', 'workers', 'd3-force-worker.js');
	const bundleOut = path.join(process.cwd(), 'public', 'workers', 'd3-force-worker.bundle.js');
	try {
		await esbuild.build({
			entryPoints: [entry],
			bundle: true,
			minify: true,
			platform: 'browser',
			target: ['es2019'],
			outfile: out,
			format: 'iife',
			sourcemap: false,
		});
		await esbuild.build({
			entryPoints: [entry],
			bundle: true,
			minify: true,
			platform: 'browser',
			target: ['es2019'],
			outfile: bundleOut,
			format: 'iife',
			sourcemap: false,
		});
		console.log('Built worker:', out);
		console.log('Built worker bundle:', bundleOut);
	} catch (e) {
		console.error('Failed to build worker', e);
		process.exit(1);
	}
}

build();
