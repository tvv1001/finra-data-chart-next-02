'use client';

import { useEffect } from 'react';

export default function ServiceWorkerRegistration() {
	useEffect(() => {
		if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) {
			return;
		}

		const register = () => {
			void navigator.serviceWorker.register('/sw.js').catch((error) => {
				console.error('Service worker registration failed:', error);
			});
		};

		if (document.readyState === 'complete') {
			register();
			return;
		}

		window.addEventListener('load', register, { once: true });
		return () => window.removeEventListener('load', register);
	}, []);

	return null;
}
