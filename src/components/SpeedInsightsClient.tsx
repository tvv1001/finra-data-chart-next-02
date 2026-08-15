'use client';

import { SpeedInsights } from '@vercel/speed-insights/next';
import { useEffect, useState } from 'react';

function isOptedOut(): boolean {
	try {
		if (typeof window === 'undefined') return false;
		if (window.localStorage.getItem('disable_analytics') === '1') return true;
		if (new URLSearchParams(window.location.search).get('disable_analytics') === '1') return true;
		if (document.cookie.split(';').map((s) => s.trim()).some((s) => s === 'disable_analytics=1')) return true;
	} catch {
		// ignore
	}
	return false;
}

export default function SpeedInsightsClient() {
	const [enabled, setEnabled] = useState(false);

	useEffect(() => {
		setEnabled(!isOptedOut());
	}, []);

	if (!enabled) return null;

	return (
		<SpeedInsights
			beforeSend={(metric) => {
				try {
					// Guard against the web-vitals GC bug where entries are undefined
					if (!metric || typeof metric !== 'object') return null;
					return metric;
				} catch {
					return null;
				}
			}}
		/>
	);
}
