'use client';
import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { renderJsonForDisplay } from '@/lib/dashboard-json';

type RecordEntity = 'individual' | 'firm';

type RecordDashboardSummary = {
	title: string;
	subtitle: string;
	keyFacts: Array<{ label: string; value: string }>;
};

type RecordDashboardDisplayMeta = {
	badgeLabel: string;
	title: string;
	subtitle: string;
	overviewCards: Array<{ label: string; value: string }>;
};

function getValue(source: Record<string, unknown>, paths: string[]): string {
	for (const path of paths) {
		const value = path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), source);
		if (typeof value === 'string' && value.trim()) return value.trim();
		if (typeof value === 'number') return String(value);
	}
	return '';
}

export function summarizeRecordDetail(payload: Record<string, unknown> | null | undefined, entity: RecordEntity, id: string): RecordDashboardSummary {
	const detail = payload && typeof payload === 'object' ? payload : {};
	const name =
		getValue(detail, ['name', 'individualName', 'firmName', 'basicInformation.firmName', 'basicInformation.name']) || `${entity === 'firm' ? 'Firm' : 'Individual'} ${id}`;
	const subtitle = `${entity === 'firm' ? 'Firm' : 'Individual'} CRD ${id}`;
	const keyFacts: Array<{ label: string; value: string }> = [];

	if (entity === 'individual') {
		const currentEmployer = getValue(detail, ['currentEmployment.0.firmName', 'currentEmployment.0.firm_name', 'basicInformation.currentEmployer']);
		if (currentEmployer) keyFacts.push({ label: 'Current employer', value: currentEmployer });
		const status = getValue(detail, ['status', 'employmentStatus', 'basicInformation.status']);
		if (status) keyFacts.push({ label: 'Status', value: status });
	} else {
		const registrationStatus = getValue(detail, ['registrationStatus', 'basicInformation.registrationStatus']);
		if (registrationStatus) keyFacts.push({ label: 'Registration status', value: registrationStatus });
		const secId = getValue(detail, ['secId', 'firmId', 'basicInformation.firmId']);
		if (secId) keyFacts.push({ label: 'SEC ID', value: secId });
	}

	return { title: name, subtitle, keyFacts };
}

export function getRecordDashboardDisplayMeta(payload: Record<string, unknown> | null | undefined, entity: RecordEntity, id: string): RecordDashboardDisplayMeta {
	const detail = payload && typeof payload === 'object' ? payload : {};
	const summary = summarizeRecordDetail(payload, entity, id);
	const overviewCards = [
		{ label: 'Entity', value: entity === 'firm' ? 'Firm' : 'Individual' },
		{ label: 'Record ID', value: id || '—' },
		{ label: 'Status', value: getValue(detail, ['status', 'employmentStatus', 'basicInformation.status', 'registrationStatus']) || '—' },
		{ label: 'Employer', value: getValue(detail, ['currentEmployment.0.firmName', 'currentEmployment.0.firm_name', 'basicInformation.currentEmployer']) || '—' },
	];

	return {
		badgeLabel: 'Read-only',
		title: summary.title,
		subtitle: summary.subtitle,
		overviewCards,
	};
}

export default function RecordDashboard() {
	const pathname = usePathname();
	const router = useRouter();
	const searchParams = useSearchParams();
	const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const segments = useMemo(() => pathname.split('/').filter(Boolean), [pathname]);
	const entity = useMemo<RecordEntity>(() => {
		const [first, second] = segments;
		if (first === 'dashboard' && second === 'firm') return 'firm';
		if (first === 'firm') return 'firm';
		return 'individual';
	}, [segments]);
	const id = useMemo(() => {
		const [first, second, third] = segments;
		if (first === 'dashboard') return third || '';
		return second || '';
	}, [segments]);
	const searchSuffix = useMemo(() => (searchParams.toString() ? `?${searchParams.toString()}` : ''), [searchParams]);

	useEffect(() => {
		if (!id) return;
		let active = true;
		setLoading(true);
		setError(null);
		fetch(`/api/finra/${entity}/${encodeURIComponent(id)}`)
			.then(async (response) => {
				if (!response.ok) throw new Error(`Request failed with ${response.status}`);
				return response.json();
			})
			.then((data) => {
				if (active) setDetail(data);
			})
			.catch((err) => {
				if (active) setError(err instanceof Error ? err.message : 'Failed to load record');
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [entity, id]);

	const summary = useMemo(() => summarizeRecordDetail(detail, entity, id), [detail, entity, id]);
	const displayMeta = useMemo(() => getRecordDashboardDisplayMeta(detail, entity, id), [detail, entity, id]);
	const detailSections = useMemo(() => {
		if (!detail) return [] as Array<{ label: string; value: string }>;
		const sections = [
			{ label: 'Name', value: getValue(detail, ['name', 'basicInformation.name', 'individualName', 'firmName']) },
			{ label: 'CRD', value: getValue(detail, ['basicInformation.crdNumber', 'crdNumber', 'crd', 'basicInformation.individualId', 'individualId']) },
			{ label: 'Status', value: getValue(detail, ['status', 'employmentStatus', 'basicInformation.status', 'registrationStatus']) },
			{ label: 'Current employer', value: getValue(detail, ['currentEmployment.0.firmName', 'currentEmployment.0.firm_name', 'basicInformation.currentEmployer']) },
			{ label: 'Related firms', value: Array.isArray(detail.employmentHistory) ? String(detail.employmentHistory.length) : '' },
		];
		return sections.filter((section) => section.value);
	}, [detail]);
	const detailBody = useMemo(() => renderJsonForDisplay(detail), [detail]);

	useEffect(() => {
		const isDashboardRecordPath = pathname.startsWith('/dashboard/individual/') || pathname.startsWith('/dashboard/firm/');
		const isLegacyRecordPath = pathname.startsWith('/individual/') || pathname.startsWith('/firm/');
		if (!id || (!isDashboardRecordPath && !isLegacyRecordPath)) return;
		const nextPath = `/dashboard/${entity}/${id}${searchSuffix}`;
		if (pathname + searchSuffix !== nextPath) {
			router.replace(nextPath, { scroll: false });
		}
	}, [entity, id, pathname, router, searchSuffix]);

	return (
		<div style={{ minHeight: '100vh', background: '#f3f4f6', color: '#111827', fontFamily: 'Inter, sans-serif' }}>
			<div style={{ maxWidth: 1400, margin: '0 auto', padding: 24, display: 'grid', gap: 20 }}>
				<header
					style={{
						background: '#ffffff',
						border: '1px solid #e5e7eb',
						borderRadius: 20,
						padding: 24,
						boxShadow: '0 8px 24px rgba(15, 23, 42, 0.06)',
						display: 'flex',
						justifyContent: 'space-between',
						alignItems: 'center',
						gap: 16,
					}}>
					<div>
						<div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#6b7280' }}>Dashboard</div>
						<h1 style={{ margin: '6px 0 4px', fontSize: 28 }}>{displayMeta.title}</h1>
						<p style={{ margin: 0, color: '#4b5563' }}>{displayMeta.subtitle}</p>
					</div>
					<div style={{ padding: '8px 12px', borderRadius: 999, background: '#ecfdf5', color: '#047857', fontWeight: 700, border: '1px solid #a7f3d0' }}>
						{displayMeta.badgeLabel}
					</div>
				</header>
				<div style={{ display: 'grid', gap: 20, gridTemplateColumns: '320px minmax(0, 1fr)' }}>
					<aside
						style={{
							background: '#ffffff',
							border: '1px solid #e5e7eb',
							borderRadius: 16,
							padding: 20,
							boxShadow: '0 8px 24px rgba(15, 23, 42, 0.06)',
							display: 'grid',
							gap: 16,
							alignContent: 'start',
						}}>
						<div>
							<div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#6b7280', marginBottom: 8 }}>Selection summary</div>
							<h2 style={{ margin: '0 0 8px', fontSize: 22 }}>{displayMeta.title}</h2>
							<p style={{ margin: 0, color: '#4b5563' }}>{displayMeta.subtitle}</p>
						</div>
						{loading && <div style={{ color: '#2563eb' }}>Loading record…</div>}
						{error && <div style={{ color: 'crimson' }}>{error}</div>}
						{summary.keyFacts.length > 0 && (
							<div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
								<div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#6b7280', marginBottom: 8 }}>Highlights</div>
								<ul style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 8 }}>
									{summary.keyFacts.map((fact) => (
										<li
											key={fact.label}
											style={{ color: '#374151' }}>
											<strong>{fact.label}:</strong> {fact.value}
										</li>
									))}
								</ul>
							</div>
						)}
						{detailSections.length > 0 && (
							<div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
								<div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#6b7280', marginBottom: 8 }}>Quick facts</div>
								<div style={{ display: 'grid', gap: 8 }}>
									{detailSections.map((section) => (
										<div key={section.label}>
											<div style={{ fontSize: 12, color: '#6b7280' }}>{section.label}</div>
											<div style={{ fontWeight: 600 }}>{section.value}</div>
										</div>
									))}
								</div>
							</div>
						)}
					</aside>
					<div style={{ display: 'grid', gap: 16 }}>
						<section style={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 16, padding: 20, boxShadow: '0 8px 24px rgba(15, 23, 42, 0.06)' }}>
							<div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#6b7280', marginBottom: 8 }}>Overview</div>
							<div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
								{displayMeta.overviewCards.map((item) => (
									<div
										key={item.label}
										style={{ background: '#f9fafb', borderRadius: 12, padding: 12 }}>
										<div style={{ fontSize: 12, color: '#6b7280' }}>{item.label}</div>
										<div style={{ fontWeight: 700, marginTop: 6 }}>{item.value}</div>
									</div>
								))}
							</div>
						</section>
						<section style={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 16, padding: 20, boxShadow: '0 8px 24px rgba(15, 23, 42, 0.06)' }}>
							<div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#6b7280', marginBottom: 12 }}>Raw payload</div>
							{detail ?
								<pre style={{ whiteSpace: 'pre-wrap', background: '#111827', color: '#f9fafb', padding: 16, borderRadius: 12, overflowX: 'auto', margin: 0 }}>{detailBody}</pre>
							:	<div style={{ color: '#6b7280' }}>No record loaded yet.</div>}
						</section>
					</div>
				</div>
			</div>
		</div>
	);
}
