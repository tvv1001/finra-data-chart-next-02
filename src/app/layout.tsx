import type { Metadata, Viewport } from 'next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import AnalyticsRouteBridge from '@/components/AnalyticsRouteBridge';
import ServiceWorkerRegistration from '@/components/ServiceWorkerRegistration';
import AnalyticsClient from '@/components/AnalyticsClient';
import './globals.css';

const siteUrl = 'https://finra-data-chart-next-02.vercel.app';

export const viewport: Viewport = {
	width: 'device-width',
	initialScale: 1,
	maximumScale: 1,
	userScalable: false,
	viewportFit: 'cover',
	interactiveWidget: 'resizes-content',
	themeColor: '#F97316',
	colorScheme: 'light',
};

export const metadata: Metadata = {
	metadataBase: new URL(siteUrl),
	manifest: '/manifest.webmanifest',
	title: {
		default: 'FINRA Network Graph',
		template: '%s | FINRA Network Graph',
	},
	description: 'Explore FINRA BrokerCheck and SEC AdviserInfo relationships in an interactive network graph for people, firms, control entities, registrations, and disclosures.',
	applicationName: 'FINRA Network Graph',
	keywords: ['FINRA', 'BrokerCheck', 'SEC AdviserInfo', 'IAPD', 'network graph', 'broker-dealer', 'investment adviser', 'CRD lookup', 'financial regulation'],
	alternates: {
		canonical: '/',
	},
	openGraph: {
		title: 'FINRA Network Graph',
		description: 'Interactive FINRA BrokerCheck and SEC AdviserInfo network visualization for exploring firms, people, employment, control, and disclosure relationships.',
		url: siteUrl,
		siteName: 'FINRA Network Graph',
		type: 'website',
		images: [
			{
				url: '/graph-screenshot.png',
				width: 1280,
				height: 720,
				alt: 'FINRA Network Graph application screenshot',
			},
		],
	},
	twitter: {
		card: 'summary_large_image',
		title: 'FINRA Network Graph',
		description: 'Browse FINRA BrokerCheck and SEC AdviserInfo records as an interactive relationship graph.',
		images: ['/graph-screenshot.png'],
	},
	robots: {
		index: true,
		follow: true,
		googleBot: {
			'index': true,
			'follow': true,
			'max-image-preview': 'large',
			'max-snippet': -1,
			'max-video-preview': -1,
		},
	},
	verification: {
		google: 'uCMyIyS-TqrZvYrlAzvLnGOAsG5KfCxDfg4Z56PduzI',
	},
	icons: {
		icon: [
			{ url: '/favicon.ico', sizes: 'any' },
			{ url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
			{ url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
			{ url: '/pwa-icon.svg', type: 'image/svg+xml' },
			{ url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
			{ url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
		],
		apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
		shortcut: ['/favicon.ico'],
	},
	appleWebApp: {
		capable: true,
		title: 'FINRA Graph',
		statusBarStyle: 'default',
	},
};

const themeLoaderScript = `
(function () {
    try {
        var theme = window.localStorage.getItem('finra_color_scheme');
        if (theme !== 'light' && theme !== 'dark') {
            theme = 'dark';
        }
        document.documentElement.dataset.theme = theme;
        document.documentElement.classList.toggle('theme-dark', theme === 'dark');
    } catch (error) {
        console.warn('Theme loader failed', error);
    }
})();
`;

const shouldRenderSpeedInsights = process.env.NODE_ENV === 'production';

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html
			lang='en'
			suppressHydrationWarning>
			<body>
				<script dangerouslySetInnerHTML={{ __html: themeLoaderScript }} />
				<ServiceWorkerRegistration />
				{children}
				<AnalyticsRouteBridge />
				{process.env.NODE_ENV === 'production' ?
					<AnalyticsClient />
				:	null}
				{shouldRenderSpeedInsights ?
					<SpeedInsights />
				:	null}
			</body>
		</html>
	);
}
