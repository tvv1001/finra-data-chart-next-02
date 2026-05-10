import re

with open('src/lib/finra-graph.ts', 'r') as f:
    text = f.read()

# 8. normalizePersonLabel
text = text.replace("const label = normalizePersonLabel(src?.name || [src?.ind_firstname, src?.ind_middlename, src?.ind_lastname].filter(Boolean).join(' '));",
                    "const label = normalizePersonLabel(src?.name || [src?.ind_firstname, src?.ind_middlename, src?.ind_lastname].filter(Boolean).join(' ') || '');")

text = text.replace("""						const personLabel = normalizePersonLabel(detail?.basicInformation?.name || src?.name || `CRD ${crd}`);
						if (!batchNodes.some((n) => n.id === personId))
							batchNodes.push({
								id: personId,
								label: personLabel,
								group: 'individual',
								crd,
							});""",
                    """						const personLabel = normalizePersonLabel(
							(detail?.basicInformation?.firstName || src?.ind_firstname) +
								(detail?.basicInformation?.middleName || src?.ind_middlename) +
								(detail?.basicInformation?.lastName || src?.ind_lastname),
						);

						if (!batchNodes.some((n) => n.id === personId)) {
							batchNodes.push({
								id: personId,
								label: personLabel,
								group: 'individual',
								crd,
							});
						}""")

text = text.replace("""							const fid = String(e?.firmId || e?.firm_id || e?.firmIdNumber || '').trim();
							if (!fid) continue;
							const firmNodeId = `firm:${fid}`;
							if (!batchNodes.some((n) => n.id === firmNodeId))
								batchNodes.push({
									id: firmNodeId,
									label: e?.firmName || `Firm ${fid}`,
									group: 'firm',
								});
							if (!batchLinks.some((l) => (l.source?.id ?? l.source) === personId && (l.target?.id ?? l.target) === firmNodeId))
								batchLinks.push({
									source: personId,
									target: firmNodeId,
									relationship: getEmploymentRelationship(e),
									isCurrent: e._isCurrent,
								});""",
                    """							const fid = String(e?.firmId || e?.firm_id || e?.firmIdNumber || e?.firmId || '').trim();
							if (!fid) continue;
							const firmNodeId = `firm:${fid}`;
							if (!batchNodes.some((n) => n.id === firmNodeId)) {
								batchNodes.push({
									id: firmNodeId,
									label: e?.firm_name || e?.firmName || `Firm ${fid}`,
									group: 'firm',
									firmId: fid,
									bdSecNumber: e?.firm_bd_sec_number || e?.bdSecNumber,
									iaSecNumber: e?.firm_ia_sec_number || e?.iaSecNumber,
								});
							}
							batchLinks.push({
								source: personId,
								target: firmNodeId,
								relationship: getEmploymentRelationship(e),
								isCurrent: e._isCurrent,
							});""")

# 9. firm node updates
text = text.replace("""						if (!batchNodes.some((n) => n.id === firmNodeId))
							batchNodes.push({
								id: firmNodeId,
								label: detail?.firmName || src?.name || `Firm ${firmId}`,
								group: 'firm',
							});""",
                    """						if (!batchNodes.some((n) => n.id === firmNodeId)) {
							batchNodes.push({
								id: firmNodeId,
								label: detail?.firmName || src?.name || `Firm ${firmId}`,
								group: 'firm',
								firmId,
								bcScope: detail?.firm_bc_scope ?? detail?.bcScope ?? null,
								disclosureFlag: detail?.disclosureFlag ?? detail?.basicInformation?.disclosureFlag ?? detail?.ind_bc_disclosure_fl,
								iaDisclosureFlag: detail?.iaDisclosureFlag ?? detail?.basicInformation?.iaDisclosureFlag ?? detail?.ind_bc_disclosure_fl,
							});
						}""")

text = text.replace("""						for (const o of detail?.directOwners || []) {
							const pid = String(o?.crdNumber || o?.crd || '').trim();
							if (!pid) continue;
							const personNodeId = `person:${pid}`;
							if (!batchNodes.some((n) => n.id === personNodeId))
								batchNodes.push({
									id: personNodeId,
									label: normalizePersonLabel(o?.legalName || o?.name || `Person ${pid}`),
									group: 'individual',
									crd: pid,
									stub: true,
								});
							if (!batchLinks.some((l) => (l.source?.id ?? l.source) === personNodeId && (l.target?.id ?? l.target) === firmNodeId))
								batchLinks.push({
									source: personNodeId,
									target: firmNodeId,
									relationship: 'controls',
								});""",
                    """						for (const o of detail?.directOwners || []) {
							const pid = String(o?.crdNumber || o?.crd || o?.personId || '').trim();
							if (!pid) continue;
							const personNodeId = `person:${pid}`;
							if (!batchNodes.some((n) => n.id === personNodeId)) {
								batchNodes.push({
									id: personNodeId,
									label: normalizePersonLabel(o?.legalName || o?.name || `Person ${pid}`),
									group: 'individual',
									crd: pid,
									bcScope: o?.bcScope || null,
									stub: true,
								});
							}
							batchLinks.push({
								source: personNodeId,
								target: firmNodeId,
								relationship: 'controls',
							});""")

# 10. fetchQueryBatch modifications
text = text.replace("""				const label = normalizePersonLabel(
					[
						parsed?.basicInformation?.firstName || src?.ind_firstname,
						parsed?.basicInformation?.middleName || src?.ind_middlename,
						parsed?.basicInformation?.lastName || src?.ind_lastname,
					]
						.filter(Boolean)
						.join(' ') || `CRD ${crd}`,
				);

				newNodes.push({ id: personId, label, group: 'individual', crd, _source: 'finra' });""",
                    """				const label =
					[
						parsed?.basicInformation?.firstName || src?.ind_firstname,
						parsed?.basicInformation?.middleName || src?.ind_middlename,
						parsed?.basicInformation?.lastName || src?.ind_lastname,
					]
						.filter(Boolean)
						.join(' ') || `CRD ${crd}`;

				// Propagate disclosure flags if present
				const disclosureFlag = src?.disclosureFlag ?? src?.ind_bc_disclosure_fl ?? parsed?.disclosureFlag ?? parsed?.basicInformation?.disclosureFlag ?? null;
				const iaDisclosureFlag = src?.iaDisclosureFlag ?? parsed?.iaDisclosureFlag ?? parsed?.basicInformation?.iaDisclosureFlag ?? null;
				newNodes.push({
					id: personId,
					label,
					group: 'individual',
					crd,
					bcScope: src?.ind_bc_scope ?? parsed?.basicInformation?.bcScope ?? null,
					iaScope: src?.ind_ia_scope ?? parsed?.basicInformation?.iaScope ?? null,
					disclosureFlag,
					iaDisclosureFlag,
					_source: 'finra',
				});""")

text = text.replace("""					if (!seenNodes.has(firmNodeId)) {
						seenNodes.add(firmNodeId);
						newNodes.push({ id: firmNodeId, label: e?.firm_name || e?.firmName || `Firm ${fid}`, group: 'firm', firmId: fid, _source: 'finra' });
					}
					newLinks.push({ source: personId, target: firmNodeId, relationship: 'employed_by', isCurrent: true });""",
                    """					if (!seenNodes.has(firmNodeId)) {
						seenNodes.add(firmNodeId);
						newNodes.push({
							id: firmNodeId,
							label: e?.firm_name || e?.firmName || `Firm ${fid}`,
							group: 'firm',
							firmId: fid,
							_source: 'finra',
						});
					}
					newLinks.push({
						source: personId,
						target: firmNodeId,
						relationship: 'employed_by',
						isCurrent: true,
					});""")

text = text.replace("""			if (!seenNodes.has(firmNodeId)) {
				seenNodes.add(firmNodeId);
				newNodes.push({ id: firmNodeId, label: src?.firm_name || src?.firmName || `Firm ${firmId}`, group: 'firm', firmId, _source: 'finra' });
			}""",
                    """			if (!seenNodes.has(firmNodeId)) {
				seenNodes.add(firmNodeId);
				// Propagate disclosure flags if present
				const disclosureFlag = src?.disclosureFlag ?? src?.firm_disclosure_flag ?? null;
				const iaDisclosureFlag = src?.iaDisclosureFlag ?? null;
				newNodes.push({
					id: firmNodeId,
					label: src?.firm_name || src?.firmName || `Firm ${firmId}`,
					group: 'firm',
					firmId,
					bcScope: src?.firm_bc_scope ?? src?.bcScope ?? null,
					disclosureFlag,
					iaDisclosureFlag,
					_source: 'finra',
				});
			}""")

with open('src/lib/finra-graph.ts', 'w') as f:
    f.write(text)
