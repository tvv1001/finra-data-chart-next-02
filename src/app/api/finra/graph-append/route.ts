import { NextRequest, NextResponse } from "next/server";
import { writeFile, readFile } from "node:fs/promises";
import { GRAPH_FILE } from "@/lib/constants";
import { getFullGraph, invalidateGraphCache, graphFileExists } from "@/lib/graphStore";
import { logger } from "@/lib/logger";
import { stripSimState } from "@/lib/graphStore";

export async function POST(request: NextRequest) {
  try {
    const { nodes: newNodes = [], links: newLinks = [] } = await request.json();
    if (!Array.isArray(newNodes) || !Array.isArray(newLinks)) {
      return NextResponse.json({ error: "nodes and links must be arrays" }, { status: 400 });
    }

    let graph: any;
    const exists = await graphFileExists();
    if (exists) {
      graph = await getFullGraph();
    } else {
      graph = { nodes: [], links: [], meta: { generated: new Date().toISOString() } };
    }

    const nodeMap = new Map<string, any>();
    for (const n of graph.nodes) nodeMap.set(n.id, n);
    let added = 0;
    for (const n of newNodes) {
      if (!nodeMap.has(n.id)) {
        nodeMap.set(n.id, stripSimState(n));
        added++;
      }
    }
    const nodeSet = new Set(nodeMap.keys());
    const linkKey = (l: any) => {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      return `${s}|${t}`;
    };
    const existingLinks = new Set(graph.links.map(linkKey));
    const addedLinks: any[] = [];
    for (const l of newLinks) {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      if (nodeSet.has(s) && nodeSet.has(t) && !existingLinks.has(linkKey(l))) {
        addedLinks.push({ source: s, target: t, type: l.type });
      }
    }

    const mergedNodes = [...nodeMap.values()];
    const mergedLinks = [...graph.links, ...addedLinks];

    // Compute meta counts for UI display
    const totalIndividuals = mergedNodes.filter((n) => n.group === 'individual').length;
    const totalFirms = mergedNodes.filter((n) => n.group === 'firm').length;
    const totalLinks = mergedLinks.length;

    const merged = {
      ...graph,
      nodes: mergedNodes,
      links: mergedLinks,
      meta: {
        ...(graph.meta || {}),
        generated: new Date().toISOString(),
        totalIndividuals,
        totalFirms,
        totalLinks,
      },
    };
    await writeFile(GRAPH_FILE, JSON.stringify(merged, null, 2), "utf-8");
    invalidateGraphCache();

    return NextResponse.json({ ok: true, addedNodes: added, addedLinks: addedLinks.length });
  } catch (err: any) {
    logger.error("graph-append error", { error: err.message });
    return NextResponse.json({ error: "Failed to append to graph." }, { status: 500 });
  }
}
