import re

with open('src/lib/finra-graph.ts', 'r') as f:
    text = f.read()

# 1. Colors
text = text.replace("nodeDefault: '#475569',", "nodeDefault: 'var(--c-default-gray)',")
text = text.replace("lineNeutral: '#5e6268',", "lineNeutral: 'var(--c-default-line-gray)',")
text = text.replace("linePreviousEmployment: '#5e6268',", "linePreviousEmployment: 'var(--c-default-line-gray)',")

# 2. searchEl block
search_block = """	// Search input (filters nodes by label, CRD, BD/IA SEC numbers)
	const searchEl = document.getElementById('fg-search') as HTMLInputElement | null;
	if (searchEl) {
		const debounced = debounce((e) => filterGraph((e.target as HTMLInputElement | null)?.value || '').catch(() => {}), 200);
		searchEl.addEventListener('input', debounced);
		searchEl.addEventListener('keydown', (ev) => {
			if (ev.key === 'Escape') {
				ev.preventDefault();
				searchEl.value = '';
				filterGraph('').catch(() => {});
			}
		});
	}

"""
text = text.replace(search_block, "")

# 3. crd parsing
text = text.replace("const crd = String(parsed?.basicInformation?.individualId || parsed?.ind_source_id || parsed?.ind_crd || parsed?.person?.crd || '').trim();",
                    "const crd = String(parsed?.basicInformation?.individualId || parsed?.ind_source_id || parsed?.ind_crd || '').trim();")

# 4. iaDisclosureFlag
text = text.replace("const iaDisclosureFlag = parsed?.iaDisclosureFlag ?? parsed?.basicInformation?.iaDisclosureFlag;",
                    "const iaDisclosureFlag = parsed?.iaDisclosureFlag ?? parsed?.basicInformation?.iaDisclosureFlag ?? parsed?.ind_bc_disclosure_fl;")

# 5. firmId
text = text.replace("const fid = String(e?.firmId || e?.firm_id || '').trim();",
                    "const fid = String(e?.firmId || e?.firm_id || e?.firmIdNumber || e?.firmId || '').trim();")

# 6. bcScope
text = text.replace("bcScope: bi.bcScope ?? detail?.bcScope,",
                    "bcScope: bi.bcScope ?? detail?.bcScope ?? null,")

# 7. stroke-opacity 0
text = text.replace(".attr('stroke', (d) => getLinkColor(d))\n\t\t\t.attr('stroke-width', (d) => getLinkWidth(d))",
                    ".attr('stroke', (d) => getLinkColor(d))\n\t\t\t.attr('stroke-opacity', 0)\n\t\t\t.attr('stroke-width', (d) => getLinkWidth(d))")

with open('src/lib/finra-graph.ts', 'w') as f:
    f.write(text)
