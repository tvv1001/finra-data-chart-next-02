'use client';

import { Analytics } from '@vercel/analytics/react';

export default function AnalyticsClient() {
	// Client-only beforeSend handler — safe to access window/localStorage here
	const beforeSend = (event: any) => {
		try {
			if (typeof window !== 'undefined') {
				const host = window.location.hostname;
				if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
					return null;
				}
				if (window.localStorage.getItem('disable_analytics') === '1') {
					return null;
				}
			}

			// drop pageviews for private paths if present
			if (event?.type === 'pageview' && typeof (event as any)?.path === 'string' && (event as any).path.includes('/private')) {
				return null;
			}

			return event;
		} catch (err) {
			return event;
		}
	};

	return <Analytics beforeSend={beforeSend} />;
}
