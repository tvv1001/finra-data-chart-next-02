import { NextRequest, NextResponse } from "next/server";
import {
  getFullGraph,
  graphFileExists,
  getProfilesFromStore,
} from "@/lib/graphStore";
import { sharedCacheHeaders } from "@/lib/httpCache";

async function getProfilesData() {
  return getProfilesFromStore();
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get("limit") ?? "0", 10);
  const profileName = searchParams.get("profile") ?? undefined;

  const exists = await graphFileExists();
  if (!exists) {
    return NextResponse.json({
      nodes: [],
      links: [],
      meta: {
        sourceLabel: "(no local graph)",
        generated: new Date().toISOString(),
        totalIndividuals: 0,
        totalFirms: 0,
        totalLinks: 0,
      },
    }, { headers: sharedCacheHeaders(120) });
  }

  if (limit > 0) {
    const graph = await getFullGraph();
    const nodes: any[] = graph.nodes || [];
    const links: any[] = graph.links || [];

    const degree = new Map<string, number>();
    for (const l of links) {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      degree.set(s, (degree.get(s) || 0) + 1);
      degree.set(t, (degree.get(t) || 0) + 1);
    }

    // Select random seeds based on the limit parameter
    const shuffled = nodes.slice().sort(() => Math.random() - 0.5);
    const seeds: any[] = shuffled.slice(0, limit);
    const seedIds = new Set(seeds.map((n) => n.id));

    if (profileName) {
      const pr = await getProfilesData();
      if (Array.isArray(pr.profiles)) {
        const prof = pr.profiles.find((p: any) => p.name === profileName);
        if (prof) {
          const profileIds = [
            ...(prof.individuals || []).map((crd: number) => `person:${crd}`),
            ...(prof.firms || []).map((crd: number) => `firm:${crd}`),
          ];
          for (const id of profileIds) {
            const node = nodes.find((n) => n.id === id);
            if (node && !seedIds.has(id)) {
              seeds.push(node);
              seedIds.add(id);
            }
          }
        }
      }
    }

    const neighborIds = new Set(seedIds);
    const adj = new Map<string, string[]>();
    for (const l of links) {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      if (!adj.has(s)) adj.set(s, []);
      if (!adj.has(t)) adj.set(t, []);
      adj.get(s)!.push(t);
      adj.get(t)!.push(s);
    }
    let frontier = new Set(seedIds);
    for (let h = 0; h < 3; h++) {
      const next = new Set<string>();
      for (const id of frontier) {
        for (const nid of adj.get(id) || []) {
          if (!neighborIds.has(nid)) {
            neighborIds.add(nid);
            next.add(nid);
          }
        }
      }
      frontier = next;
      if (frontier.size === 0) break;
    }

    return NextResponse.json({
      nodes: nodes.filter((n) => neighborIds.has(n.id)),
      links: links.filter((l) => {
        const s = l.source?.id ?? l.source;
        const t = l.target?.id ?? l.target;
        return neighborIds.has(s) && neighborIds.has(t);
      }),
      meta: {
        ...(graph.meta || {}),
        subset: true,
        subsetSize: seeds.length,
        totalNodes: nodes.length,
        totalLinks: links.length,
      },
    }, { headers: sharedCacheHeaders(120) });
  }

  // Return full graph from store (Redis on Vercel, filesystem locally)
  const graph = await getFullGraph();
  return NextResponse.json(graph, { headers: sharedCacheHeaders(120) });
}
