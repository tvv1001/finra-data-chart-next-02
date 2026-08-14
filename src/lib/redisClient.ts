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
		return res?.map(r => r[0] ? { error: r[0].message } : { result: r[1] });
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
			request: executeLocalRequest
		} as any);
	}

	const url1 = process.env.UPSTASH_REDIS_REST_URL;
	const token1 = process.env.UPSTASH_REDIS_REST_TOKEN;
	const url2 = process.env.UPSTASH_REDIS_REST_URL_2;
	const token2 = process.env.UPSTASH_REDIS_REST_TOKEN_2;

	const hasDb1 = !!(url1 && token1);
	const hasDb2 = !!(url2 && token2);

	if (hasDb1 && hasDb2) {
		const client1 = new UpstashRedis({ url: url1, token: token1 });
		const client2 = new UpstashRedis({ url: url2, token: token2 });
		
		const readMethods = new Set(['get', 'mget', 'scan', 'zrange', 'smembers', 'hgetall', 'exists', 'dbsize', 'type', 'keys', 'hget', 'zrevrange']);
		const writeMethods = new Set(['set', 'mset', 'hset', 'zadd', 'sadd', 'del', 'incr', 'incrby', 'expire', 'flushall', 'flushdb']);

		return new Proxy(client2, {
			get(target, prop) {
				const val = (target as any)[prop];
				if (typeof val === 'function') {
					return function(...args: any[]) {
						const propStr = prop as string;
						if (readMethods.has(propStr)) {
							return (async () => {
								const useFirst = Math.random() < 0.5;
								const primary = useFirst ? client1 : client2;
								const secondary = useFirst ? client2 : client1;
								try {
									return await (primary as any)[propStr](...args);
								} catch (err: any) {
									console.warn(`[Redis LB] Error on primary for ${propStr}, falling back... (${err.message})`);
									return await (secondary as any)[propStr](...args);
								}
							})();
						} else if (writeMethods.has(propStr)) {
							return (async () => {
								const p1 = (client1 as any)[propStr](...args).catch((e: any) => console.error(`[Redis LB] Write error DB1:`, e.message));
								const p2 = (client2 as any)[propStr](...args).catch((e: any) => console.error(`[Redis LB] Write error DB2:`, e.message));
								const results = await Promise.all([p1, p2]);
								return results[1] !== undefined ? results[1] : results[0];
							})();
						}
						// Direct passthrough for other methods (like pipeline)
						return (client1 as any)[propStr](...args);
					};
				}
				return val;
			}
		});
	}

	// Production behavior single instance
	return new UpstashRedis({
		url: url2 || config.url,
		token: token2 || config.token
	});
}
