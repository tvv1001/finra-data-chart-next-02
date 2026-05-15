import Script from 'next/script';

const umamiWebsiteId = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID?.trim();
const umamiScriptUrl = process.env.NEXT_PUBLIC_UMAMI_SCRIPT_URL?.trim();
const umamiDomains = process.env.NEXT_PUBLIC_UMAMI_DOMAINS?.trim();

export default function UmamiAnalytics() {
	if (!umamiWebsiteId || !umamiScriptUrl) {
		return null;
	}

	return (
		<Script
			id='umami-analytics'
			src={umamiScriptUrl}
			strategy='afterInteractive'
			async
			data-website-id={umamiWebsiteId}
			data-domains={umamiDomains || undefined}
		/>
	);
}
