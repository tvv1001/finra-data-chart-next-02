'use client';

import { useEffect } from 'react';

export default function ServiceWorkerRegistration() {
	useEffect(() => {
		const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
		if (process.env.NODE_ENV !== 'production' || isLocalhost || !('serviceWorker' in navigator)) {
			if ('serviceWorker' in navigator && isLocalhost) {
				navigator.serviceWorker.getRegistrations().then((registrations) => {
					for (const registration of registrations) {
						void registration.unregister();
					}
				});
			}
			if (window.caches && isLocalhost) {
				window.caches.keys().then((names) => {
					for (const name of names) {
						void window.caches.delete(name);
					}
				});
			}
			return;
		}

		let hasReloadedForUpdate = false;

		const promptWaitingWorkerToActivate = (registration: ServiceWorkerRegistration) => {
			if (registration.waiting && navigator.serviceWorker.controller) {
				registration.waiting.postMessage({ type: 'SKIP_WAITING' });
			}
		};

		const watchInstallingWorker = (registration: ServiceWorkerRegistration) => {
			const worker = registration.installing;
			if (!worker) {
				return;
			}

			worker.addEventListener('statechange', () => {
				if (worker.state === 'installed') {
					promptWaitingWorkerToActivate(registration);
				}
			});
		};

		const register = async () => {
			try {
				const registration = await navigator.serviceWorker.register('/sw.js', {
					updateViaCache: 'none',
				});

				promptWaitingWorkerToActivate(registration);
				watchInstallingWorker(registration);
				registration.addEventListener('updatefound', () => {
					watchInstallingWorker(registration);
				});

				void registration.update();

				const refreshRegistration = () => {
					void registration.update();
				};

				const handleVisibilityChange = () => {
					if (document.visibilityState === 'visible') {
						refreshRegistration();
					}
				};

				const handleControllerChange = () => {
					if (hasReloadedForUpdate) {
						return;
					}

					hasReloadedForUpdate = true;
					window.location.reload();
				};

				navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
				window.addEventListener('focus', refreshRegistration);
				document.addEventListener('visibilitychange', handleVisibilityChange);

				return () => {
					navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
					window.removeEventListener('focus', refreshRegistration);
					document.removeEventListener('visibilitychange', handleVisibilityChange);
				};
			} catch (error) {
				console.error('Service worker registration failed:', error);
			}
		};

		let cleanup: (() => void) | undefined;

		const startRegistration = () => {
			void register().then((teardown) => {
				cleanup = teardown;
			});
		};

		if (document.readyState === 'complete') {
			startRegistration();
		} else {
			window.addEventListener('load', startRegistration, { once: true });
		}

		return () => {
			window.removeEventListener('load', startRegistration);
			cleanup?.();
		};
	}, []);

	return null;
}
