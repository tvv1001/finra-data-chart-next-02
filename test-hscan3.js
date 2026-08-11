const { Redis } = require('@upstash/redis');
const r = new Redis({ request: async (req) => {
  return { result: ["0", ["field1", '{"foo": "bar"}', "field2", '{"foo": "baz"}']] }
} });
r.hscan("mykey", "0", { count: 1000, match: "*" }).then(res => console.log(JSON.stringify(res))).catch(console.error);
