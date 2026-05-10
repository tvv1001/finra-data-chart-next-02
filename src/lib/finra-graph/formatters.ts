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
			return `${first} ${last}`.replace(/\s+/g, ' ').trim();
		}
	}

	return s;
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
