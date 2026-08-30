const fs = require('fs');
const files = [
  'src/lib/hydration.ts',
  'src/lib/graphStore.ts',
  'src/lib/searchDirectFallback.ts',
  'src/lib/simpleCache.ts',
  'src/lib/seedStore.ts',
  'src/lib/redisCache.ts',
  'src/lib/primedRedisSync.ts',
  'src/lib/localSearch.ts',
  'src/lib/cache.ts',
  'src/lib/peopleClusterCache.ts'
];
for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  if (!content.includes("@upstash/redis")) {
    content = "import type { Redis } from '@upstash/redis';\n" + content;
    fs.writeFileSync(file, content, 'utf8');
    console.log("Fixed " + file);
  }
}
