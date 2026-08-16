import Link from 'next/link';
import { getRedisClientInstance } from '@/lib/redisClient';

export const revalidate = 0;

async function fetchMonitored(redis: any, role: 'individual' | 'firm', limit = 200) {
	try {
		const setKey = `dashboard:monitored-crds:${role}`;
		const members = (await redis.smembers(setKey)) || [];
		const slice = members.slice(0, limit);
		const snapKeys = slice.map((id: string) => `dashboard:crd-name-snapshot:${role}:${id}`);
		const snaps = snapKeys.length ? await redis.mget(...snapKeys).catch(() => []) : [];
		const rows = slice.map((id: string, i: number) => {
			let parsed = null;
			try {
				parsed = snaps[i] ? JSON.parse(snaps[i]) : null;
			} catch {
				parsed = null;
			}
			return { id, name: parsed?.name || null, ts: parsed?.ts || null };
		});
		return rows;
	} catch (e) {
		return [];
	}
}

export default async function MonitoredPage() {
	let redis: any = null;
	try {
		redis = getRedisClientInstance({ url: process.env.UPSTASH_REDIS_REST_URL || '', token: process.env.UPSTASH_REDIS_REST_TOKEN || '' });
	} catch (e) {
		// fallthrough
	}

	if (!redis) {
		return (
			<div style={{ padding: 16 }}>
				<h2>Monitored CRDs</h2>
				<p>No Redis client available. Ensure Redis is configured (USE_LOCAL_REDIS=1 for local).</p>
			</div>
		);
	}

	const [individuals, firms, alerts] = await Promise.all([
		fetchMonitored(redis, 'individual', 500),
		fetchMonitored(redis, 'firm', 500),
		redis.lrange('dashboard:alerts', 0, 199).catch(() => []),
	]);

	return (
		<div style={{ padding: 16 }}>
			<h2>Monitored CRDs</h2>
			<section style={{ marginBottom: 24 }}>
				<h3>Individuals ({individuals.length})</h3>
				<ul>
					{individuals.map((r: any) => (
						<li key={`ind-${r.id}`}>
							<Link href={`/dashboard/individual/${encodeURIComponent(r.id)}`}>{r.name || `Person ${r.id}`}</Link>
							{r.ts ?
								<span style={{ marginLeft: 8, color: '#666' }}> · snapshot {new Date(r.ts).toLocaleString()}</span>
							:	null}
						</li>
					))}
				</ul>
			</section>

			<section style={{ marginBottom: 24 }}>
				<h3>Firms ({firms.length})</h3>
				<ul>
					{firms.map((r: any) => (
						<li key={`firm-${r.id}`}>
							<Link href={`/dashboard/firm/${encodeURIComponent(r.id)}`}>{r.name || `Firm ${r.id}`}</Link>
							{r.ts ?
								<span style={{ marginLeft: 8, color: '#666' }}> · snapshot {new Date(r.ts).toLocaleString()}</span>
							:	null}
						</li>
					))}
				</ul>
			</section>

			<section>
				<h3>Recent Alerts (most recent)</h3>
				<ul>
					{(alerts || []).map((a: any, idx: number) => {
						let parsed = a;
						try {
							parsed = typeof a === 'string' ? JSON.parse(a) : a;
						} catch {
							parsed = a;
						}
						return (
							<li key={`alert-${idx}`}>
								<strong>{parsed?.type || 'alert'}</strong> · {parsed?.entity || parsed?.id} · {parsed?.prevName ? `${parsed.prevName} → ${parsed.nextName}` : parsed?.note || ''}
								<span style={{ marginLeft: 8, color: '#666' }}>{parsed?.at ? new Date(parsed.at).toLocaleString() : ''}</span>
							</li>
						);
					})}
				</ul>
			</section>
		</div>
	);
}
