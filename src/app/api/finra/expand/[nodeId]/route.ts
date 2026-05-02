import { NextRequest, NextResponse } from "next/server";
import { getFullGraph } from "@/lib/graphStore";
import { logger } from "@/lib/logger";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ nodeId: string }> },
) {
  try {
    const { nodeId } = await params;
    const graph = await getFullGraph();
    const nodes: any[] = graph.nodes || [];
    const links: any[] = graph.links || [];

    const neighborIds = new Set<string>();
    const neighborLinks: any[] = [];
    for (const l of links) {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      if (s === nodeId) {
        neighborIds.add(t);
        neighborLinks.push(l);
      } else if (t === nodeId) {
        neighborIds.add(s);
        neighborLinks.push(l);
      }
    }

    const neighborNodes = nodes.filter((n) => neighborIds.has(n.id));
    const selfNode = nodes.find((n) => n.id === nodeId);
    const resultNodes = selfNode ? [selfNode, ...neighborNodes] : neighborNodes;

    return NextResponse.json({ nodes: resultNodes, links: neighborLinks });
  } catch (err: any) {
    logger.error("expand error", { error: err.message });
    return NextResponse.json({ error: "Failed to expand node." }, { status: 500 });
  }
}
