const { Redis } = require('@upstash/redis');
const r = new Redis({ url: "https://example.com", token: "foo", fetch: () => Promise.resolve(new Response(JSON.stringify({result: "MOCKED"}))) });
r.get("foo").then(console.log).catch(console.error);
