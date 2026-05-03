import { NextRequest, NextResponse } from "next/server";
import { getFullGraph, saveGraph } from "@/lib/graphStore";

export async function POST(req: NextRequest) {
  try {
    const graph = await getFullGraph();
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const links = Array.isArray(graph.links) ? graph.links : [];
    const totalIndividuals = nodes.filter((n) => n.group === "individual" || String(n.id || "").startsWith("person:")).length;
    const totalFirms = nodes.filter((n) => n.group === "firm" || String(n.id || "").startsWith("firm:")).length;
    const totalLinks = links.length;
    graph.meta = { ...(graph.meta || {}), generated: new Date().toISOString(), totalIndividuals, totalFirms, totalLinks };
    await saveGraph(graph);
    return NextResponse.json({ ok: true, meta: graph.meta });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
