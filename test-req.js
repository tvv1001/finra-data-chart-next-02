const { Redis } = require('@upstash/redis');
const r = new Redis({
  request: async (req) => {
    console.log("REQUEST:", JSON.stringify(req));
    return { result: "MOCKED" }
  }
});
r.get("foo");
r.hvals("bar");
r.pipeline().get("baz").hvals("qux").exec();
