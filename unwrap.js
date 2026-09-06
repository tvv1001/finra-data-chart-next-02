function unwrapDetailPayload(detail) {
	if (!detail) return detail;

	// Helper to recursively parse string/wrapped/object detail content
	const parseEmbeddedDetail = (val) => {
		if (!val) return null;
		if (typeof val === 'string') {
			try {
				const parsed = JSON.parse(val);
				return parseEmbeddedDetail(parsed);
			} catch {
				return null;
			}
		}
		if (typeof val === 'object') {
			if (val.content !== undefined) {
				return parseEmbeddedDetail(val.content);
			}
			return val;
		}
		return null;
	};

	const isPlainObjectLocal = (value) => {
		return value != null && typeof value === 'object' && !Array.isArray(value);
	};

	const mergePreferPrimaryLocal = (primary, secondary) => {
		if (primary == null || primary === '') return secondary;
		if (secondary == null || secondary === '') return primary;
		if (Array.isArray(primary) && Array.isArray(secondary)) {
			if (!primary.length) return secondary;
			if (!secondary.length) return primary;
			const seen = new Set(primary.map((item) => JSON.stringify(item)));
			return [
				...primary,
				...secondary.filter((item) => {
					const key = JSON.stringify(item);
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				}),
			];
		}
		if (isPlainObjectLocal(primary) && isPlainObjectLocal(secondary)) {
			const merged = { ...primary };
			for (const [key, value] of Object.entries(secondary)) {
				merged[key] = key in merged ? mergePreferPrimaryLocal(merged[key], value) : value;
			}
			return merged;
		}
		return primary;
	};

	// 1. If it's a merged route response (contains .merged or .finraNode)
	let parsedWrapped = null;
	if (detail?.merged || detail?.finraNode) {
		const wrapped = detail.merged || detail.finraNode;
		parsedWrapped = parseEmbeddedDetail(wrapped);
		if (parsedWrapped) {
			detail = {
				...parsedWrapped,
				found: detail.found ?? parsedWrapped.found,
				hasFinraData: detail.hasFinraData ?? parsedWrapped.hasFinraData,
				hasSecData: detail.hasSecData ?? parsedWrapped.hasSecData,
				sources: detail.sources ?? parsedWrapped.sources,
			};
		}
	}

	// 2. If it is an unmerged response with separate bccontent and/or iacontent (either as string or object)
	if (detail?.bccontent !== undefined || detail?.iacontent !== undefined) {
		const finraDetail = parseEmbeddedDetail(detail.bccontent);
		const secDetail = parseEmbeddedDetail(detail.iacontent);

		if (finraDetail || secDetail) {
			const merged =
				finraDetail ?
					secDetail ? mergePreferPrimaryLocal(secDetail, finraDetail)
					:	finraDetail
				:	secDetail;

			if (merged && typeof merged === 'object') {
				// Enrich with metadata
				const finraNumeric = finraDetail ? finraDetail.individualId || finraDetail.crd || detail.crd || '' : '';
				const secNumeric = secDetail ? secDetail.individualId || secDetail.crd || detail.crd || '' : '';

				merged.found = detail.found ?? true;
				merged.hasFinraData = detail.hasFinraData ?? (!!finraDetail && !!finraNumeric && hasIndividualSourceCoverage(finraDetail, 'finra'));
				merged.hasSecData = detail.hasSecData ?? (!!secDetail && !!secNumeric && hasIndividualSourceCoverage(secDetail, 'sec'));
				merged.sources = detail.sources ?? {
					finra: finraDetail ? { bccontent: finraDetail } : null,
					sec: secDetail ? { iacontent: secDetail } : null,
				};
				return merged;
			}
		}
	}

	// 3. Fallback to parsing container directly (like Elasticsearch/Solr structures or top-level content)
	const parsedDirect = parseEmbeddedDetail(detail);
	if (parsedDirect && parsedDirect !== detail) {
		return {
			...parsedDirect,
			found: detail.found ?? parsedDirect.found,
			hasFinraData: detail.hasFinraData ?? parsedDirect.hasFinraData,
			hasSecData: detail.hasSecData ?? parsedDirect.hasSecData,
			sources: detail.sources ?? parsedDirect.sources,
		};
	}

	// 4. Solr / Elasticsearch search hits fallback
	const hit = detail?.hits?.hits?.[0] || detail?.response?.docs?.[0];
	if (hit) {
		const src = hit._source || hit;
		const parsedHit = parseEmbeddedDetail(src);
		if (parsedHit) {
			if (detail.found !== undefined) parsedHit.found = detail.found;
			return parsedHit;
		}
		return src;
	}

	return detail;
}
module.exports = { unwrapDetailPayload };