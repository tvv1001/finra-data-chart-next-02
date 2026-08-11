const fs = require('fs');
const child_process = require('child_process');

const filesStr = child_process.execSync('grep -rlE ": Redis |: Redis<|as Redis| Redis \\\||redis: Redis" src/lib/ src/app/api/').toString();
const files = filesStr.split('\n').filter(Boolean);

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  if (!content.includes("@upstash/redis") && !content.includes("type Redis")) {
    content = "import type { Redis } from '@upstash/redis';\n" + content;
    fs.writeFileSync(file, content, 'utf8');
    console.log("Fixed " + file);
  }
}
