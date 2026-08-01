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

function getValue(source: Record<string, unknown>, paths: string[]): string {
	for (const path of paths) {
		const value = path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), source);
		if (typeof value === 'string' && value.trim()) return value.trim();
		if (typeof value === 'number') return String(value);
	}
	return '';
}

function getNestedObject(source: Record<string, unknown>, paths: string[]): Record<string, unknown> | null {
	for (const path of paths) {
		const value = path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), source);
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
	}
	return null;
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

export default function RecordDashboard() {
	const pathname = usePathname();
	const router = useRouter();
	const searchParams = useSearchParams();
	const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const segments = useMemo(() => pathname.split('/').filter(Boolean), [pathname]);
	const entity = useMemo<RecordEntity>(() => (segments[0] === 'firm' ? 'firm' : 'individual'), [segments]);
	const id = segments[1] || '';
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
	const detailSections = useMemo(() => {
		if (!detail) return [] as Array<{ label: string; value: string }>;
		const sections = [
			{ label: 'Basic info', value: getValue(detail, ['basicInformation', 'basicInformation.name', 'name']) },
			{ label: 'CRD', value: getValue(detail, ['basicInformation.crdNumber', 'crdNumber', 'crd']) },
			{ label: 'Status', value: getValue(detail, ['status', 'employmentStatus', 'basicInformation.status']) },
			{ label: 'Current employer', value: getValue(detail, ['currentEmployment.0.firmName', 'currentEmployment.0.firm_name']) },
			{ label: 'Related firms', value: String(Array.isArray(detail?.employmentHistory) ? detail.employmentHistory.length : 0) },
		];
		return sections.filter((section) => section.value);
	}, [detail]);
	const detailBody = useMemo(() => renderJsonForDisplay(detail), [detail]);

	useEffect(() => {
		if (!id || (!pathname.startsWith('/individual/') && !pathname.startsWith('/firm/'))) return;
		const nextPath = `/${entity}/${id}${searchSuffix}`;
		if (pathname + searchSuffix !== nextPath) {
			router.replace(nextPath, { scroll: false });
		}
	}, [entity, id, pathname, router, searchSuffix]);

	return (
		<div style={{ minHeight: '100vh', background: '#f3f4f6', color: '#111827', fontFamily: 'Inter, sans-serif' }}>
			<div style={{ maxWidth: 1400, margin: '0 auto', padding: 24, display: 'grid', gap: 20, gridTemplateColumns: '320px minmax(0, 1fr)' }}>
				<aside style={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 16, padding: 20, boxShadow: '0 8px 24px rgba(15, 23, 42, 0.06)' }}>
					<div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#6b7280', marginBottom: 12 }}>Record view</div>
					<h2 style={{ margin: '0 0 8px', fontSize: 24 }}>{summary.title}</h2>
					<p style={{ margin: '0 0 16px', color: '#4b5563' }}>{summary.subtitle}</p>
					{loading && <p style={{ color: '#2563eb' }}>Loading record…</p>}
					{error && <p style={{ color: 'crimson' }}>{error}</p>}
					{summary.keyFacts.length > 0 && (
						<ul style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 8 }}>
							{summary.keyFacts.map((fact) => (
								<li
									key={fact.label}
									style={{ color: '#374151' }}>
									<strong>{fact.label}:</strong> {fact.value}
								</li>
							))}
						</ul>
					)}
					{detailSections.length > 0 && (
						<div style={{ marginTop: 18, borderTop: '1px solid #e5e7eb', paddingTop: 16 }}>
							{detailSections.map((section) => (
								<div
									key={section.label}
									style={{ marginBottom: 10 }}>
									<div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.14em', color: '#6b7280' }}>{section.label}</div>
									<div style={{ fontWeight: 600 }}>{section.value}</div>
								</div>
							))}
						</div>
					)}
				</aside>
				<section style={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 16, padding: 24, boxShadow: '0 8px 24px rgba(15, 23, 42, 0.06)' }}>
					<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
						<div>
							<div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#6b7280' }}>Detail payload</div>
							<h3 style={{ margin: '4px 0 0', fontSize: 20 }}>Raw record view</h3>
						</div>
					</div>
					{detail ?
						<pre style={{ whiteSpace: 'pre-wrap', background: '#111827', color: '#f9fafb', padding: 16, borderRadius: 12, overflowX: 'auto', margin: 0 }}>{detailBody}</pre>
					:	<div style={{ color: '#6b7280' }}>No record loaded yet.</div>}
				</section>
			</div>
		</div>
	);
}
