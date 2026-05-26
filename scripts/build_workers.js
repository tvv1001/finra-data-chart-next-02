#!/usr/bin/env node
const esbuild = require('esbuild');
const path = require('path');

async function build() {
	const entry = path.join(process.cwd(), 'src', 'workers', 'd3-force-worker-src.js');
	const out = path.join(process.cwd(), 'public', 'workers', 'd3-force-worker.js');
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
		console.log('Built worker:', out);
	} catch (e) {
		console.error('Failed to build worker', e);
		process.exit(1);
	}
}

build();
