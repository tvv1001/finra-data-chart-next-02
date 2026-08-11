const { Redis } = require('@upstash/redis');
const r = new Redis({ request: async (req) => {
  console.log(JSON.stringify(req.body));
  return { result: ["0", []] }
} });
r.hscan("mykey", "0", { count: 1000, match: "*" });
