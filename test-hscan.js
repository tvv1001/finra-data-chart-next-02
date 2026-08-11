const { Redis } = require('@upstash/redis');
const r = new Redis({ request: async (req) => {
  return { result: ["123", ["field1", "val1", "field2", "val2"]] }
} });
r.hscan("mykey", "0", { count: 10 }).then(console.log).catch(console.error);
