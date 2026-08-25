import IORedis from 'ioredis';
const r = new IORedis('redis://127.0.0.1:6379');
for (const k of ['finra:firm:319484_brokers:connected','finra:firm:319484_brokers:previous','sec:firm:319484_brokers:connected','sec:firm:319484_brokers:previous']) {
  const t = await r.type(k);
  const v = t === 'string' ? await r.get(k) : null;
  console.log(k, '->', t, v ? JSON.parse(v).length + ' ids' : '');
}
process.exit(0);
