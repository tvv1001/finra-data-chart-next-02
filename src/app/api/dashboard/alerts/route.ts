import { NextResponse } from 'next/server';
import { getRedisClientInstance } from '@/lib/redisClient';

export const revalidate = 0;

export async function GET(request: Request) {
	const limitParam = new URL(request.url).searchParams.get('limit') || '10';
	const limit = Math.min(200, Math.max(1, parseInt(limitParam, 10) || 10));
	try {
		const redis = getRedisClientInstance({ url: process.env.UPSTASH_REDIS_REST_URL || '', token: process.env.UPSTASH_REDIS_REST_TOKEN || '' });
		const items = await redis.lrange('dashboard:alerts', 0, limit - 1).catch(() => []);
		return NextResponse.json({ alerts: items || [] });
	} catch (e: any) {
		return NextResponse.json({ alerts: [], error: String(e?.message || e) }, { status: 500 });
	}
}
