import { NextResponse } from 'next/server';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walkCountJson(dir: string) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    let count = 0;
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) count += walkCountJson(p);
      else if (e.isFile() && p.endsWith('.json')) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

export async function GET() {
  const workspaceRoot = process.cwd();
  const externalDir = join(workspaceRoot, 'data', 'external');
  const nationalDir = join(workspaceRoot, 'data', 'national');

  const external = walkCountJson(externalDir);
  const national = walkCountJson(nationalDir);

  return NextResponse.json({ ok: true, counts: { external, national }, ts: new Date().toISOString() });
}
