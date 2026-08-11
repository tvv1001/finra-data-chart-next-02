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

	// Production behavior
	return new UpstashRedis({
		url: config.url,
		token: config.token
	});
}
