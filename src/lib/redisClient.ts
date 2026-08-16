import { Redis as UpstashRedis } from '@upstash/redis';
import IORedis from 'ioredis';

let localIoRedis: IORedis | null = null;

async function executeLocalRequest(req: any): Promise<any> {
	if (!localIoRedis) {
		localIoRedis = new IORedis('redis://127.0.0.1:6379');
		console.log('Other local applications can now connect to your shared local cache at redis://127.0.0.1:6379!');
	}

	let body = req.body || [];
	if (typeof body === 'string') {
		body = JSON.parse(body);
	}

	if (Array.isArray(body) && Array.isArray(body[0])) {
		// pipeline
		const pipeline = localIoRedis.pipeline();
		body.forEach((cmd: any) => {
			// @ts-ignore
			pipeline.sendCommand(new IORedis.Command(cmd[0], cmd.slice(1)));
		});
		const res = await pipeline.exec();
		return res?.map((r) => (r[0] ? { error: r[0].message } : { result: r[1] }));
	} else if (Array.isArray(body)) {
		try {
			const res = await localIoRedis.sendCommand(new IORedis.Command(body[0], body.slice(1)));
			return { result: res };
		} catch (e: any) {
			return { error: e.message };
		}
	} else {
		return { error: 'Invalid payload' };
	}
}

export function getRedisClientInstance(config: { url: string; token: string }) {
	const isLocalhost = process.env.USE_LOCAL_REDIS === '1';

	if (isLocalhost) {
		return new UpstashRedis({
			request: executeLocalRequest,
		} as any);
	}

	const url1 = process.env.UPSTASH_REDIS_REST_URL;
	const token1 = process.env.UPSTASH_REDIS_REST_TOKEN;
	const url2 = process.env.UPSTASH_REDIS_REST_URL_2;
	const token2 = process.env.UPSTASH_REDIS_REST_TOKEN_2;

	const hasDb1 = !!(url1 && token1);
	const hasDb2 = !!(url2 && token2);
	const disableDb2 = process.env.UPSTASH_REDIS_DISABLE_2 === '1';

	// If DB2 is explicitly disabled via env, prefer DB1 when available and avoid the dual-proxy.
	if (hasDb1 && hasDb2 && !disableDb2) {
		const client1 = new UpstashRedis({ url: url1, token: token1 });
		const client2 = new UpstashRedis({ url: url2, token: token2 });

		const readMethods = new Set(['get', 'mget', 'scan', 'zrange', 'smembers', 'hgetall', 'exists', 'dbsize', 'type', 'keys', 'hget', 'zrevrange']);
		const writeMethods = new Set(['set', 'mset', 'hset', 'zadd', 'sadd', 'del', 'incr', 'incrby', 'expire', 'flushall', 'flushdb']);

		let db1Maxxed = false;
		let db2Maxxed = false;

		const checkMaxxed = (err: any, dbIndex: 1 | 2) => {
			const msg = String(err?.message || '').toLowerCase();
			if (msg.includes('max') || msg.includes('limit') || msg.includes('exceeded') || msg.includes('daily')) {
				if (dbIndex === 1) db1Maxxed = true;
				else db2Maxxed = true;
				console.warn(`[Redis LB] DB${dbIndex} marked as maxxed out!`);
			}
		};

		return new Proxy(client2, {
			get(target, prop) {
				const val = (target as any)[prop];
				if (typeof val === 'function') {
					return function (...args: any[]) {
						const propStr = prop as string;
						if (readMethods.has(propStr)) {
							return (async () => {
								if (db1Maxxed && db2Maxxed) {
									if (propStr === 'scan') return ['0', []];
									if (propStr === 'mget' || propStr === 'zrange' || propStr === 'zrevrange' || propStr === 'smembers' || propStr === 'keys') return [];
									if (propStr === 'exists' || propStr === 'dbsize') return 0;
									if (propStr === 'hgetall') return {};
									return null;
								}

								let primary = client2;
								let secondary = client1;
								let primaryIndex: 1 | 2 = 2;
								let secondaryIndex: 1 | 2 = 1;

								if (!db1Maxxed && (db2Maxxed || Math.random() < 0.5)) {
									primary = client1;
									secondary = client2;
									primaryIndex = 1;
									secondaryIndex = 2;
								}

								try {
									let res = await (primary as any)[propStr](...args);
									if ((res === null || res === undefined) && !db1Maxxed && !db2Maxxed) {
										// Fallback if null (helpful during partial migrations), only if other DB is healthy
										res = await (secondary as any)[propStr](...args);
									}
									return res;
								} catch (err: any) {
									checkMaxxed(err, primaryIndex);
									if (db1Maxxed && db2Maxxed) {
										if (propStr === 'scan') return ['0', []];
										if (propStr === 'mget' || propStr === 'zrange' || propStr === 'zrevrange' || propStr === 'smembers' || propStr === 'keys') return [];
										if (propStr === 'exists' || propStr === 'dbsize') return 0;
										if (propStr === 'hgetall') return {};
										return null;
									}
									console.warn(`[Redis LB] Error on DB${primaryIndex} for ${propStr}, falling back to DB${secondaryIndex}... (${err.message})`);
									try {
										return await (secondary as any)[propStr](...args);
									} catch (err2: any) {
										checkMaxxed(err2, secondaryIndex);
										if (propStr === 'scan') return ['0', []];
										if (propStr === 'mget' || propStr === 'zrange' || propStr === 'zrevrange' || propStr === 'smembers' || propStr === 'keys') return [];
										if (propStr === 'exists' || propStr === 'dbsize') return 0;
										if (propStr === 'hgetall') return {};
										return null;
									}
								}
							})();
						} else if (writeMethods.has(propStr)) {
							return (async () => {
								const promises = [];
								if (!db1Maxxed)
									promises.push(
										(client1 as any)[propStr](...args).catch((e: any) => {
											checkMaxxed(e, 1);
											console.error(`[Redis LB] Write error DB1:`, e.message);
										}),
									);
								else promises.push(Promise.resolve(undefined));

								if (!db2Maxxed)
									promises.push(
										(client2 as any)[propStr](...args).catch((e: any) => {
											checkMaxxed(e, 2);
											console.error(`[Redis LB] Write error DB2:`, e.message);
										}),
									);
								else promises.push(Promise.resolve(undefined));

								const results = await Promise.all(promises);
								return results[1] !== undefined ? results[1] : results[0];
							})();
						}
						// Direct passthrough for other methods (like pipeline)
						return (db1Maxxed ? client2 : (client1 as any))[propStr](...args);
					};
				}
				return val;
			},
		});
	}

	// Single-instance behavior. Prefer DB1 when present; otherwise use DB2 or the provided config.
	if (hasDb1) {
		return new UpstashRedis({ url: url1, token: token1 });
	}
	if (hasDb2) {
		return new UpstashRedis({ url: url2, token: token2 });
	}

	return new UpstashRedis({ url: config.url, token: config.token });
}
