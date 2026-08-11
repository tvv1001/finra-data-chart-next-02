const { Redis } = require('@upstash/redis');
const r = new Redis({
  request: async (req) => {
    return { result: "MOCKED" }
  }
});
r.get("foo").then(console.log).catch(console.error);
