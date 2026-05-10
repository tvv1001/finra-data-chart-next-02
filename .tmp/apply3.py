import re

with open('src/lib/finra-graph.ts', 'r') as f:
    text = f.read()

# 1. personHasRelationship
text = text.replace("const allLinks = [...(Array.isArray(layoutLinks) ? layoutLinks : []), ...(Array.isArray(graphData?.links) ? graphData.links : [])];",
                    """const allLinks = [...(Array.isArray(layoutLinks) ? layoutLinks : [])].concat(
		...Array.from(graphData?.links || []).map((l) => {
			const sourceId = l.source?.id ?? l.source;
			const targetId = l.target?.id ?? l.target;
			return { sourceId, targetId };
		}),
	);""")

# 2. ensureIndividualDetail fallback
text = text.replace("if (!detail || (detail.found === false && !detail.basicInformation)) {",
                    "if (!detail || (detail.found === false && !detail.basicInformation && !detail.firmName)) {")

# 3. revealNeighbors
text = text.replace("applyGraphDerivedNodeMetrics(layoutNodes, layoutLinks);\n\tconst newlyAddedNodeIds = new Set(newNodes.map((n) => n.id));",
                    "applyGraphDerivedNodeMetrics(layoutNodes, layoutLinks);")

# 5. renderPersonDetail URLs
text = text.replace("""	const bcRawUrl =
		bi.individualId ?
			`https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?hl=true&includePrevious=true&nrows=12&r=25&sort=bc_lastname_sort+asc,bc_firstname_sort+asc,bc_middlename_sort+asc,score+desc&wt=json`
		:	null;
	const secRawUrl =
		bi.individualId ?
			`https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}?hl=true&includePrevious=true&nrows=12&r=25&sort=bc_lastname_sort+asc,bc_firstname_sort+asc,bc_middlename_sort+asc,score+desc&wt=json`
		:	null;""",
                    """	const bcRawUrl = bi.individualId ? `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}`.trim() : null;
	const secRawUrl = bi.individualId ? `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}`.trim() : null;""")

# 6. cityState in timeline
text = text.replace("""									return `<div class="${cls}">
                  <span class="fg-tl-firm">${esc(e.firmName)}${e.bdSecNumber ? ` <small>SEC#${esc(e.bdSecNumber)}</small>` : ''}</span>
                  <span class="fg-tl-dates">${esc(e.start || '–')} → ${esc(e.end || 'present')}</span>
                  ${e.loc ? `<span class="fg-tl-loc">${esc(e.loc)}</span>` : ''}
                  ${scopeTags.length ? `<span class="fg-tl-loc" style="color:var(--text-m)">${esc(scopeTags.join(' · '))}</span>` : ''}
                  ${e.expelledDate ? `<span class="fg-badge inactive">Expelled ${esc(e.expelledDate)}</span>` : ''}
                </div>`;""",
                    """									return `<div class="${cls}">
                  <span class="fg-tl-firm">${esc(e.firmName)}${e.bdSecNumber ? ` <small>SEC#${esc(e.bdSecNumber)}</small>` : ''}</span>
                  ${e.cityState ? `<span class="fg-tl-loc">${esc(e.cityState)}</span>` : ''}
                  <span class="fg-tl-dates">${esc(e.start || '–')} → ${esc(e.end || 'present')}</span>
                </div>`;""")

# 7. bcScope regex
text = text.replace("`<span class=\"fg-badge ${/\\b(active|approved)\\b/i.test(String(d.bcScope)) ? 'active' : 'inactive'}>${esc(capitalize(String(d.bcScope || '').toLowerCase()))}</span>`",
                    "`<span class=\"fg-badge ${/\\b(active|approved)\\b/i.test(String(d.bcScope || '').trim()) ? 'active' : 'inactive'}\">${esc(capitalize(String(d.bcScope || '').toLowerCase()))}</span>`")

# 8. renderFirmDetail URLs
text = text.replace("""	const bcRawUrl = firmId ? `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(firmId)}?hl=true&nrows=12&query=&start=0&wt=json` : null;
	const secRawUrl = firmId ? `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(firmId)}?hl=true&nrows=12&query=smith&r=25&sort=score+desc&wt=json` : null;""",
                    """	const bcRawUrl = firmId ? `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(firmId)}`.trim() : null;
	const secRawUrl = firmId ? `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(firmId)}`.trim() : null;""")

with open('src/lib/finra-graph.ts', 'w') as f:
    f.write(text)
