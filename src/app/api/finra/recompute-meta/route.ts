import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import { GRAPH_FILE } from "@/lib/constants";
import { invalidateGraphCache } from "@/lib/graphStore";

export async function POST(req: NextRequest) {
  try {
    const raw = await readFile(GRAPH_FILE, "utf-8");
    const graph = JSON.parse(raw);
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const links = Array.isArray(graph.links) ? graph.links : [];
    const totalIndividuals = nodes.filter((n) => n.group === "individual" || String(n.id || "").startsWith("person:")).length;
    const totalFirms = nodes.filter((n) => n.group === "firm" || String(n.id || "").startsWith("firm:")).length;
    const totalLinks = links.length;
    graph.meta = { ...(graph.meta || {}), generated: new Date().toISOString(), totalIndividuals, totalFirms, totalLinks };
    await writeFile(GRAPH_FILE, JSON.stringify(graph, null, 2), "utf-8");
    invalidateGraphCache();
    return NextResponse.json({ ok: true, meta: graph.meta });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
