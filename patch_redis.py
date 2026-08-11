import os
import glob

def patch_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()
    
    if 'import { Redis } from \'@upstash/redis\'' in content or 'import { Redis } from "@upstash/redis"' in content:
        # Replace import
        content = content.replace("import { Redis } from '@upstash/redis';", "import { getRedisClientInstance } from '@/lib/redisClient';")
        content = content.replace('import { Redis } from "@upstash/redis";', 'import { getRedisClientInstance } from "@/lib/redisClient";')
        
        # Replace instantiation
        content = content.replace("new Redis({ url, token })", "getRedisClientInstance({ url, token })")
        
        with open(filepath, 'w') as f:
            f.write(content)
        print(f"Patched {filepath}")

for root, _, files in os.walk('src'):
    for file in files:
        if file.endswith('.ts') or file.endswith('.tsx'):
            patch_file(os.path.join(root, file))
