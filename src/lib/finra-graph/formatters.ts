export function esc(str) {
	return String(str || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/\"/g, '&quot;');
}

export function normalizePersonLabel(str) {
	const s = String(str || '').trim();
	if (!s) return '';

	const commaMatch = s.match(/^([^,]+),\s*(.+)$/);
	if (commaMatch) {
		const last = commaMatch[1].trim();
		const first = commaMatch[2].trim();
		const isPersonName = /^[A-Za-z .'-]+$/.test(first) && /^[A-Za-z .'-]+$/.test(last);
		if (isPersonName && first.split(/\s+/).length <= 4 && last.split(/\s+/).length <= 3) {
			return formatUiText(`${first} ${last}`.replace(/\s+/g, ' ').trim());
		}
	}

	return !/[a-z]/.test(s) ? formatUiText(s) : s;
}

export function formatNodeLabel(str) {
	const s = String(str || '').trim();
	if (!s) return '';
	return s
		.split(/\s+/)
		.map((word) => {
			return word
				.split(/([-\/])/)
				.map((part) => {
					if (!part) return '';
					return part.length === 1 && /[-\/]/.test(part) ? part : part[0].toUpperCase() + part.slice(1).toLowerCase();
				})
				.join('');
		})
		.join(' ');
}

export function capitalize(str) {
	const s = String(str || '').trim();
	return s ? s[0].toUpperCase() + s.slice(1) : '';
}

export function formatUiText(str) {
	const raw = String(str || '').trim();
	if (!raw) return '';

	const normalizedSpacing = raw.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
	const shouldNormalizeCase = !/[a-z]/.test(normalizedSpacing);
	const source = shouldNormalizeCase ? normalizedSpacing.toLowerCase() : normalizedSpacing;
	const acronyms = new Set(['IA', 'FINRA', 'SEC', 'CRD', 'SRO', 'PDF', 'ADV', 'BD']);

	return source
		.split(/\s+/)
		.map((word) => {
			return word
				.split(/([-\/])/)
				.map((part) => {
					if (!part) return '';
					if (/^[-\/]$/.test(part)) return part;
					const upper = part.toUpperCase();
					if (acronyms.has(upper)) return upper;
					return part[0].toUpperCase() + part.slice(1).toLowerCase();
				})
				.join('');
		})
		.join(' ');
}

export function formatLocationText(str) {
	const raw = String(str || '').trim();
	if (!raw) return '';

	const normalizedSpacing = raw.replace(/\s+/g, ' ').trim();
	const uppercaseTokens = new Set([
		'N',
		'S',
		'E',
		'W',
		'NE',
		'NW',
		'SE',
		'SW',
		'NY',
		'NJ',
		'CT',
		'MA',
		'PA',
		'DC',
		'DE',
		'RI',
		'VT',
		'NH',
		'ME',
		'MD',
		'VA',
		'NC',
		'SC',
		'GA',
		'FL',
		'AL',
		'MS',
		'TN',
		'KY',
		'OH',
		'MI',
		'IN',
		'IL',
		'WI',
		'MN',
		'IA',
		'MO',
		'AR',
		'LA',
		'TX',
		'OK',
		'KS',
		'NE',
		'SD',
		'ND',
		'MT',
		'WY',
		'CO',
		'NM',
		'AZ',
		'UT',
		'ID',
		'NV',
		'CA',
		'OR',
		'WA',
		'AK',
		'HI',
		'PR',
		'VI',
		'GU',
		'AS',
		'MP',
		'PO',
		'P.O.',
	]);

	function formatCore(core) {
		if (!core) return core;
		if (/^\d+[A-Za-z]?$/.test(core)) return core.toUpperCase();
		if (/^\d+$/.test(core)) return core;
		const upper = core.toUpperCase();
		if (uppercaseTokens.has(upper)) return upper;
		const source = !/[a-z]/.test(core) ? core.toLowerCase() : core;
		if (/^mc[a-z]/.test(source)) {
			return `Mc${source.charAt(2).toUpperCase()}${source.slice(3).toLowerCase()}`;
		}
		return source.charAt(0).toUpperCase() + source.slice(1).toLowerCase();
	}

	function formatPart(part) {
		if (!part || /^[-/]$/.test(part)) return part;
		const match = part.match(/^([^A-Za-z0-9]*)([A-Za-z0-9'.]+)([^A-Za-z0-9]*)$/);
		if (!match) return part;
		const [, prefix, core, suffix] = match;
		return `${prefix}${formatCore(core)}${suffix}`;
	}

	return normalizedSpacing
		.split(',')
		.map((segment) =>
			segment
				.trim()
				.split(/\s+/)
				.map((word) =>
					word
						.split(/([-\/])/)
						.map((part) => formatPart(part))
						.join(''),
				)
				.join(' '),
		)
		.filter(Boolean)
		.join(', ');
}

export function truncate(str, n) {
	return str && str.length > n ? str.slice(0, n - 1) + '…' : str;
}

export function firmSizeLabel(size) {
	if (size == null) return '';
	const s = String(size).trim();
	if (/^\d+$/.test(s)) {
		const n = parseInt(s, 10);
		if (n <= 150) return `Small (${n.toLocaleString()})`;
		if (n <= 499) return `Mid (${n.toLocaleString()})`;
		return `Large (${n.toLocaleString()})`;
	}
	switch (s.toLowerCase()) {
		case 'small':
			return 'Small (1-150)';
		case 'mid':
		case 'medium':
			return 'Mid (151-499)';
		case 'large':
			return 'Large (500+)';
		default:
			return capitalize(s);
	}
}

export function openSidebarToggles() {
	const sidebar = document.getElementById('fg-sidebar-inner');
	if (!sidebar) return;
	const toggles = sidebar.querySelectorAll<HTMLDetailsElement>('details.fg-section-toggle');
	toggles.forEach((toggle) => {
		toggle.open = true;
	});
}

export function row(label, value, extraClass = '') {
	return `<div class="fg-detail-row${extraClass ? ` ${extraClass}` : ''}">
    <span class="fg-label">${label}</span>
    <span>${value}</span>
  </div>`;
}
