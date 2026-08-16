#!/usr/bin/env ts-node
import fs from 'fs';
import path from 'path';
// dynamic import at runtime to avoid TS extension resolution issues when running
// this script with different ts-node/node ESM configurations.
// We'll import the module dynamically inside the main function.

// argv will be parsed inside the async main to keep this file ESM/CJS compatible
let firmId = '';

(async () => {
	try {
		// parse argv here (ESM-safe)
		console.log('process.argv:', process.argv.slice(0, 10));
		const minimist = (await import('minimist')).default;
		const argv = minimist(process.argv.slice(2));
		console.log('parsed argv:', argv);
		firmId = String(argv.firm || argv.f || (argv._ && argv._[0]) || '').trim() || String(argv['firm'] || '').trim();
		if (!firmId) {
			console.error('Usage: --firm <CRD>');
			process.exit(2);
		}

		console.log('Computing firm connections for', firmId);
		// dynamic import of graphConnections using tsconfig paths support provided by tsconfig-paths/register
		const mod = await import(path.join(process.cwd(), 'src', 'lib', 'graphConnections')).catch(() => import(path.join(process.cwd(), 'src', 'lib', 'graphConnections.ts')));
		const res = await (mod?.getFirmConnectionsFromGraph ? mod.getFirmConnectionsFromGraph(firmId) : mod?.default?.getFirmConnectionsFromGraph?.(firmId));
		const outDir = path.join(process.cwd(), 'data', 'firm-connections');
		fs.mkdirSync(outDir, { recursive: true });
		const outPath = path.join(outDir, `${firmId}.json`);
		fs.writeFileSync(outPath, JSON.stringify(res));
		console.log('Wrote', outPath, 'current=', res.currentConnections.length, 'previous=', res.previousConnections.length);
	} catch (e) {
		console.error('Error computing connections:', (e as Error)?.message || e);
		process.exit(1);
	}
})();
