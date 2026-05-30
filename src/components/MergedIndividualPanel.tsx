import React from 'react';

type Merged = any;

export default function MergedIndividualPanel({ merged }: { merged: Merged }) {
	if (!merged) return <div>No merged data provided</div>;

	const bi = merged.basicInformation || {};
	const sources = merged.basicInformationSources || {};

	const renderBadge = (s: string) => {
		const color =
			s === 'finra' ? '#0b5fff'
			: s === 'sec' ? '#118c4e'
			: '#666';
		const style: React.CSSProperties = {
			display: 'inline-block',
			background: color,
			color: 'white',
			padding: '2px 6px',
			borderRadius: 4,
			fontSize: 12,
			marginLeft: 8,
		};
		return <span style={style}>{s}</span>;
	};

	return (
		<div style={{ fontFamily: 'Inter, system-ui, sans-serif', padding: 12 }}>
			<h3 style={{ margin: '0 0 8px 0' }}>
				{bi.firstName} {bi.middleName || ''} {bi.lastName}
				{sources && sources.firstName ? renderBadge(sources.firstName) : null}
			</h3>

			<section style={{ marginBottom: 12 }}>
				<h4 style={{ margin: '6px 0' }}>Basic Information</h4>
				<table>
					<tbody>
						{Object.keys(bi).map((k) => (
							<tr key={k}>
								<td style={{ paddingRight: 12, verticalAlign: 'top', fontWeight: 600 }}>{k}</td>
								<td style={{ paddingRight: 12 }}>{JSON.stringify(bi[k])}</td>
								<td>{sources && sources[k] ? renderBadge(sources[k]) : null}</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>

			<section style={{ marginBottom: 12 }}>
				<h4>Current Employments</h4>
				{(merged.currentEmployments || []).map((c: any, idx: number) => (
					<div
						key={idx}
						style={{ padding: 8, border: '1px solid #eee', marginBottom: 8 }}>
						<div style={{ fontWeight: 700 }}>
							{c.firmName} {c._source ? renderBadge(c._source) : null}
						</div>
						<div style={{ color: '#444', fontSize: 13 }}>{c.branchOfficeLocations && c.branchOfficeLocations[0] && c.branchOfficeLocations[0].street1}</div>
					</div>
				))}
			</section>

			<section>
				<h4>Previous Employments</h4>
				{(merged.previousEmployments || []).map((p: any, idx: number) => (
					<div
						key={idx}
						style={{ padding: 8, border: '1px solid #eee', marginBottom: 8 }}>
						<div style={{ fontWeight: 700 }}>
							{p.firmName} {p._source ? renderBadge(p._source) : null}
						</div>
						<div style={{ color: '#444', fontSize: 13 }}>
							{p.city}, {p.state}
						</div>
					</div>
				))}
			</section>
		</div>
	);
}
