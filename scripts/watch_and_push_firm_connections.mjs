import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const dir = path.join(process.cwd(), 'data', 'firm-connections');
if (!fs.existsSync(dir)) {
	console.error('directory not found', dir);
	process.exit(2);
}

console.log('watching', dir, 'for new firm-connections files');

let timer = null;
const debounceMs = 500;

function handleFileEvent(filename) {
	if (!filename || !filename.endsWith('.json')) return;
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		const fp = path.join(dir, filename);
		if (!fs.existsSync(fp)) return;
		console.log('detected', filename, '- pushing via batch script (single)');
		try {
			execSync(`node scripts/push_firm_connections_to_redis.mjs ${path.basename(filename, '.json')}`, { stdio: 'inherit' });
		} catch (e) {
			console.error('push failed', e?.message || e);
		}
	}, debounceMs);
}

fs.watch(dir, (ev, filename) => {
	if (ev === 'rename' || ev === 'change') handleFileEvent(filename);
});

// Also handle existing files at startup by pushing them once (optional)
// Uncomment below to push all at startup
// execSync('node scripts/push_all_firm_connections_to_redis.mjs --run', { stdio: 'inherit' });
