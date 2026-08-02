{hasCurrentRecord && (
								<div className="current-crd-banner">
									<div className="banner-context-row">
										<span className={`record-side-badge ${currentRecordEntity ? String(currentRecordEntity).toLowerCase() : ''}`}>
											{currentRecordEntity ? String(currentRecordEntity).toUpperCase() : 'UNKNOWN'}
										</span>
										<span className="banner-context-meta">
											<span className="banner-context-meta-item">
												<span className="banner-context-meta-label">CRD</span>
												<span className="banner-context-meta-value">{currentRecordId}</span>
											</span>
										</span>
										<span className="banner-context-status-tags">
											{detailedMainRecord?.registeredSros?.length ? (
												detailedMainRecord.registeredSros.slice(0, 2).map((sro: string, idx: number) => (
													<span key={idx} className="record-pill record-pill--status-active">{sro}</span>
												))
											) : (
												<span className="record-pill record-pill--status-active">Active</span>
											)}
										</span>
									</div>
									<div className="current-crd-label banner-header-row">
										<div className="banner-title-stack">
											<div className="current-crd-text">
												<div className="current-crd-name-block">
													<div className="current-crd-main-name">{orphanRecord?.name?.toUpperCase() || mainJsonLabel}</div>
													{detailedMainRecord && detailedMainRecord.otherNames.length > 0 && (
														<div className="current-crd-meta-line">
															{detailedMainRecord.otherNames.slice(0, 3).map((name: string) => (
																<span key={name} className="crd-sub-label">{name}</span>
															))}
														</div>
													)}
												</div>
											</div>
											<div className={styles.mainViewToggle} style={{ marginLeft: 'auto' }}>
												<button
													type='button'
													className={`${styles.mainViewToggleBtn} ${mainViewMode === 'card' ? styles.mainViewToggleBtnActive : ''}`}
													onClick={() => setMainViewMode('card')}>
													Info
												</button>
												<button
													type='button'
													className={`${styles.mainViewToggleBtn} ${mainViewMode === 'json' ? styles.mainViewToggleBtnActive : ''}`}
													onClick={() => setMainViewMode('json')}>
													Log
												</button>
											</div>
										</div>
									</div>
								</div>
							)}

							{syncBannerText && <div className={styles.statusLine} style={{ marginBottom: 14 }}>{syncBannerText}</div>}

							{hasCurrentRecord && (
								<div className="record-workspace-wrapper">
									<div className="record-workspace">
										{/* Optional: we can put tabs here if we didn't put them in the banner, but we moved Card/JSON to the banner */}
										<div className="record-detail-wrapper">
											{mainViewMode === 'json' && (
												<div className={styles.jsonPanel} style={{ border: 'none' }}>
													{jsonRenderBusy && <div className={styles.searchSummary}>Rendering JSON…</div>}
													{jsonTree ?
														<div className={styles.jsonTreeList}>{renderJsonTree(jsonTree)}</div>
													:	<pre>{codeBlock}</pre>}
												</div>
											)}

											{mainViewMode === 'card' && (
												<div
													className="record-detail-view combined-record-detail-view"
													onClickCapture={handleInternalDashboardLinkClick}>
													
													{orphanRecord ? (
														<>
															<div className={styles.detailList}>
																{orphanRecord.officeAddress && (
																	<div className={styles.detailRow}>
																		<div className={styles.detailTextRow}>
																			<strong>Main Address:</strong> {formatAddress(orphanRecord.officeAddress)}
																		</div>
																	</div>
																)}
																{orphanRecord.mailingAddress && (
																	<div className={styles.detailRow}>
																		<div className={styles.detailTextRow}>
																			<strong>Mailing:</strong> {formatAddress(orphanRecord.mailingAddress)}
																		</div>
																	</div>
																)}
																{orphanRecord.phone && (
																	<div className={styles.detailRow}>
																		<div className={styles.detailTextRow}>
																			<strong>Phone:</strong> {orphanRecord.phone}
																		</div>
																	</div>
																)}
															</div>

															<section
																className="record-detail-section"
																style={{ marginTop: '24px' }}>
																<h4 className="record-detail-section-title">Profile Links</h4>
																<OrphanProfileLinks parentCrd={String(orphanRecord.parentCrd)} />
															</section>

															<section className="record-detail-section">
																<h4 className="record-detail-section-title">General Information</h4>
																<div className={styles.detailList}>
																	{orphanRecord.name && (
																		<div className={styles.detailRow}>
																			<div className={styles.detailTextRow}>
																				<strong>Name:</strong> {orphanRecord.name}
																			</div>
																		</div>
																	)}
																	<div className={styles.detailRow}>
																		<div className={styles.detailTextRow}>
																			<strong>Individual CRD:</strong> {currentRecordId}
																		</div>
																	</div>
																	{orphanRecord.position && (
																		<div className={styles.detailRow}>
																			<div className={styles.detailTextRow}>
																				<strong>Position:</strong> {orphanRecord.position}
																			</div>
																		</div>
																	)}
																	{orphanRecord.firmName && (
																		<div className={styles.detailRow}>
																			<div className={styles.detailTextRow}>
																				<strong>Affiliated Firm:</strong> {orphanRecord.firmName}
																			</div>
																		</div>
																	)}
																	{orphanRecord.parentCrd && (
																		<div className={styles.detailRow}>
																			<div className={styles.detailTextRow}>
																				<strong>Parent Firm CRD:</strong>{' '}
																				<Link
																					href={`/dashboard/firm/${orphanRecord.parentCrd}`}
																					className={styles.detailInlineTag}>
																					Firm #{orphanRecord.parentCrd}
																				</Link>
																			</div>
																		</div>
																	)}
																</div>
															</section>

															{orphanRecord.firmName && orphanRecord.parentCrd && (
																<section className="record-detail-section">
																	<h4 className="record-detail-section-title">Current Employment (1)</h4>
																	<div className="record-detail-list">
																		<Link
																			href={`/dashboard/firm/${orphanRecord.parentCrd}`}
																			className="record-detail-item record-detail-item-clickable">
																			<div className="record-detail-item-title">
																				{orphanRecord.firmName}
																				<button type="button" className="record-detail-inline-tag record-detail-inline-tag-button">
																					CRD#{orphanRecord.parentCrd}
																				</button>
																			</div>
																			<div className="record-detail-item-subtitle">{orphanRecord.position}</div>
																		</Link>
																	</div>
																</section>
															)}

															<div className={styles.orphanNoticeAlert}>
																No independent BrokerCheck/SEC record exists for CRD {currentRecordId}. This person was scraped from{' '}
																<Link
																	href={`/dashboard/firm/${orphanRecord.parentCrd}`}
																	className={styles.detailInlineTag}>
																	Firm CRD#{orphanRecord.parentCrd}
																</Link>
																's own detail record as "{orphanRecord.position}", and has no live CRD of its own.
															</div>
														</>
													) : detailedMainRecord ? (
														<>
															<section className="record-detail-hero">
																<div className="record-detail-grid">
																	{detailedMainRecord.mainAddress && (
																		<div><strong>Main Address:</strong> {detailedMainRecord.mainAddress}</div>
																	)}
																	{detailedMainRecord.mailingAddress && (
																		<div><strong>Mailing:</strong> {detailedMainRecord.mailingAddress}</div>
																	)}
																	{detailedMainRecord.phone && (
																		<div><strong>Phone:</strong> {detailedMainRecord.phone}</div>
																	)}
																</div>
																{detailedMainRecord.otherNames.length > 0 && (
																	<div className="record-detail-other-names">
																		<span className="record-detail-other-names-label">Other names</span>
																		<div className="record-detail-other-names-list">
																			{detailedMainRecord.otherNames.map((name: string) => (
																				<span key={name} className="record-detail-other-name">{name}</span>
																			))}
																		</div>
																	</div>
																)}
															</section>

															{detailedMainRecord.profileLinks.length > 0 && (
																<section className="record-detail-section">
																	<h4 className="record-detail-section-title">Profile links</h4>
																	<div className="banner-context-links profile-links-section">
																		{detailedMainRecord.profileLinks.map((link: any) => (
																			<a
																				key={link.url}
																				className={`profile-link ${link.label.toLowerCase().includes('finra') ? 'finra-link' : 'sec-link'}`}
																				href={link.url}
																				target="_blank"
																				rel="noopener noreferrer">
																				{link.label} ↗
																			</a>
																		))}
																	</div>
																</section>
															)}

															{detailedMainRecord.generalInfo.length > 0 && (
																<section className="record-detail-section">
																	<h4 className="record-detail-section-title">Profile</h4>
																	<div className="record-detail-grid">
																		{detailedMainRecord.generalInfo.map((row: any, idx: number) => (
																			<div key={idx}><strong>{row.label}:</strong> {row.value}</div>
																		))}
																	</div>
																</section>
															)}

															{detailedMainRecord.currentEmployment.length > 0 && (
																<section className="record-detail-section">
																	<h4 className="record-detail-section-title">Current Employment ({detailedMainRecord.currentEmployment.length})</h4>
																	<div className="record-detail-list">
																		{detailedMainRecord.currentEmployment.map((row: any, idx: number) => {
																			const firmId = pickFirstValidCrd(row.firmId, row.bdSecNumber, row.iaSecNumber);
																			return (
																				<div key={idx} className={`record-detail-item ${firmId ? 'record-detail-item-clickable' : ''}`} role={firmId ? 'button' : undefined} tabIndex={firmId ? 0 : undefined} data-href={firmId ? `/dashboard/firm/${firmId}` : undefined}>
																					<div className="record-detail-item-title">
																						{row.firmName || 'Unknown Firm'}
																						{firmId && (
																							<button type="button" className="record-detail-inline-tag record-detail-inline-tag-button">
																								CRD#{firmId}
																							</button>
																						)}
																					</div>
																					<div className="record-detail-item-subtitle">{row.branchLocation || 'Unknown Location'}</div>
																				</div>
																			);
																		})}
																	</div>
																</section>
															)}

															{detailedMainRecord.currentConnectionCards.length > 0 && (
																<section className="record-detail-section">
																	<h4 className="record-detail-section-title">Current Connections ({detailedMainRecord.currentConnectionCards.length})</h4>
																	<div className="record-detail-list">
																		{detailedMainRecord.currentConnectionCards.map((item: any, idx: number) => (
																			<div key={idx} className={`record-detail-item ${item.crd ? 'record-detail-item-clickable' : ''}`} role={item.crd ? 'button' : undefined} tabIndex={item.crd ? 0 : undefined} data-href={item.crd ? `/dashboard/individual/${item.crd}` : undefined}>
																				<div className="record-detail-item-title">
																					{item.name || 'Unknown'}
																					{item.crd && (
																						<button type="button" className="record-detail-inline-tag record-detail-inline-tag-button">
																							CRD#{item.crd}
																						</button>
																					)}
																				</div>
																				{item.subtitle && <div className="record-detail-item-subtitle">{item.subtitle}</div>}
																			</div>
																		))}
																	</div>
																</section>
															)}

															{detailedMainRecord.previousEmployment.length > 0 && (
																<section className="record-detail-section">
																	<h4 className="record-detail-section-title">Previous Employment ({detailedMainRecord.previousEmployment.length})</h4>
																	<div className="record-detail-list">
																		{detailedMainRecord.previousEmployment.map((row: any, idx: number) => {
																			const firmId = pickFirstValidCrd(row.firmId, row.bdSecNumber, row.iaSecNumber);
																			return (
																				<div key={idx} className={`record-detail-item ${firmId ? 'record-detail-item-clickable' : ''}`} role={firmId ? 'button' : undefined} tabIndex={firmId ? 0 : undefined} data-href={firmId ? `/dashboard/firm/${firmId}` : undefined}>
																					<div className="record-detail-item-title">
																						{row.firmName || 'Unknown Firm'}
																						{firmId && (
																							<button type="button" className="record-detail-inline-tag record-detail-inline-tag-button">
																								CRD#{firmId}
																							</button>
																						)}
																					</div>
																					<div className="record-detail-item-subtitle">{row.dateRange || 'Unknown Dates'}</div>
																				</div>
																			);
																		})}
																	</div>
																</section>
															)}

															{detailedMainRecord.previousConnectionCards.length > 0 && (
																<section className="record-detail-section">
																	<h4 className="record-detail-section-title">Previous Connections ({detailedMainRecord.previousConnectionCards.length})</h4>
																	<div className="record-detail-list">
																		{detailedMainRecord.previousConnectionCards.map((item: any, idx: number) => (
																			<div key={idx} className={`record-detail-item ${item.crd ? 'record-detail-item-clickable' : ''}`} role={item.crd ? 'button' : undefined} tabIndex={item.crd ? 0 : undefined} data-href={item.crd ? `/dashboard/individual/${item.crd}` : undefined}>
																				<div className="record-detail-item-title">
																					{item.name || 'Unknown'}
																					{item.crd && (
																						<button type="button" className="record-detail-inline-tag record-detail-inline-tag-button">
																							CRD#{item.crd}
																						</button>
																					)}
																				</div>
																				{item.subtitle && <div className="record-detail-item-subtitle">{item.subtitle}</div>}
																			</div>
																		))}
																	</div>
																</section>
															)}

															{detailedMainRecord.directOwners?.length > 0 && (
																<section className="record-detail-section">
																	<h4 className="record-detail-section-title">Direct Owners & Executive Officers ({detailedMainRecord.directOwners.length})</h4>
																	<div className="record-detail-list">
																		{detailedMainRecord.directOwners.map((row: any, idx: number) => {
																			const personId = pickFirstValidCrd(row.individualId, row.firmId, row.crd, row.crdNumber);
																			return (
																				<div key={idx} className={`record-detail-item ${personId ? 'record-detail-item-clickable' : ''}`} role={personId ? 'button' : undefined} tabIndex={personId ? 0 : undefined} data-href={personId ? `/dashboard/individual/${personId}` : undefined}>
																					<div className="record-detail-item-title">
																						{row.name || row.ownerName || 'Unknown Owner'}
																						{personId && (
																							<button type="button" className="record-detail-inline-tag record-detail-inline-tag-button">
																								CRD#{personId}
																							</button>
																						)}
																					</div>
																					<div className="record-detail-item-subtitle">{row.title || row.position || 'Owner'}</div>
																				</div>
																			);
																		})}
																	</div>
																</section>
															)}

															{detailedMainRecord.indirectOwners?.length > 0 && (
																<section className="record-detail-section">
																	<h4 className="record-detail-section-title">Indirect Owners ({detailedMainRecord.indirectOwners.length})</h4>
																	<div className="record-detail-list">
																		{detailedMainRecord.indirectOwners.map((row: any, idx: number) => {
																			const personId = pickFirstValidCrd(row.individualId, row.firmId, row.crd, row.crdNumber);
																			return (
																				<div key={idx} className={`record-detail-item ${personId ? 'record-detail-item-clickable' : ''}`} role={personId ? 'button' : undefined} tabIndex={personId ? 0 : undefined} data-href={personId ? `/dashboard/individual/${personId}` : undefined}>
																					<div className="record-detail-item-title">
																						{row.name || row.ownerName || 'Unknown Owner'}
																						{personId && (
																							<button type="button" className="record-detail-inline-tag record-detail-inline-tag-button">
																								CRD#{personId}
																							</button>
																						)}
																					</div>
																					<div className="record-detail-item-subtitle">{row.title || row.position || 'Owner'}</div>
																				</div>
																			);
																		})}
																	</div>
																</section>
															)}

															{detailedMainRecord.stateExams.length > 0 && (
																<section className="record-detail-section">
																	<h4 className="record-detail-section-title">State Exam Category ({detailedMainRecord.stateExams.length})</h4>
																	<div className="record-detail-list">
																		{detailedMainRecord.stateExams.map((row: any, idx: number) => (
																			<div key={idx} className="record-detail-item">
																				<div className="record-detail-item-title">
																					{row.name || 'Unknown Exam'}
																					<span className="record-detail-inline-tag record-detail-inline-tag--finra">
																						{row.scope || 'State'}
																					</span>
																				</div>
																				<div className="record-detail-item-subtitle">{row.date || 'Unknown Date'}</div>
																			</div>
																		))}
																	</div>
																</section>
															)}

															{detailedMainRecord.productExams.length > 0 && (
																<section className="record-detail-section">
																	<h4 className="record-detail-section-title">Product Exam Category ({detailedMainRecord.productExams.length})</h4>
																	<div className="record-detail-list">
																		{detailedMainRecord.productExams.map((row: any, idx: number) => (
																			<div key={idx} className="record-detail-item">
																				<div className="record-detail-item-title">
																					{row.name || 'Unknown Exam'}
																					<span className="record-detail-inline-tag record-detail-inline-tag--finra">
																						{row.scope || 'Product'}
																					</span>
																				</div>
																				<div className="record-detail-item-subtitle">{row.date || 'Unknown Date'}</div>
																			</div>
																		))}
																	</div>
																</section>
															)}

															{detailedMainRecord.principalExams.length > 0 && (
																<section className="record-detail-section">
																	<h4 className="record-detail-section-title">Principal Exam Category ({detailedMainRecord.principalExams.length})</h4>
																	<div className="record-detail-list">
																		{detailedMainRecord.principalExams.map((row: any, idx: number) => (
																			<div key={idx} className="record-detail-item">
																				<div className="record-detail-item-title">
																					{row.name || 'Unknown Exam'}
																					<span className="record-detail-inline-tag record-detail-inline-tag--finra">
																						{row.scope || 'Principal'}
																					</span>
																				</div>
																				<div className="record-detail-item-subtitle">{row.date || 'Unknown Date'}</div>
																			</div>
																		))}
																	</div>
																</section>
															)}

															{detailedMainRecord.jurisdictionCards.length > 0 && (
																<section className="record-detail-section">
																	<h4 className="record-detail-section-title">Registered States ({detailedMainRecord.jurisdictionCards.length})</h4>
																	<div className="record-detail-grid">
																		{detailedMainRecord.jurisdictionCards.map((item: any, idx: number) => (
																			<div key={idx}><strong>{item.title}:</strong> {item.meta} ({item.subtitle})</div>
																		))}
																	</div>
																</section>
															)}

															{detailedMainRecord.additionalDetails.length > 0 && (
																<section className="record-detail-section">
																	<h4 className="record-detail-section-title">Additional Properties</h4>
																	<div className="record-detail-grid">
																		{detailedMainRecord.additionalDetails.map((entry: any) => (
																			<div key={entry.label}><strong>{entry.label}:</strong> {entry.value}</div>
																		))}
																	</div>
																</section>
															)}
														</>
													) : (
														<div className={styles.readableCardEmpty}>No detailed data found for this record.</div>
													)}
												</div>
											)}
										</div>
									</div>
								</div>
							)}
