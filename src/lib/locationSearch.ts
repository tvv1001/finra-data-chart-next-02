const STATE_NAME_TO_CODE: Record<string, string> = {
	alabama: 'AL',
	alaska: 'AK',
	arizona: 'AZ',
	arkansas: 'AR',
	california: 'CA',
	colorado: 'CO',
	connecticut: 'CT',
	delaware: 'DE',
	'district of columbia': 'DC',
	florida: 'FL',
	georgia: 'GA',
	hawaii: 'HI',
	idaho: 'ID',
	illinois: 'IL',
	indiana: 'IN',
	iowa: 'IA',
	kansas: 'KS',
	kentucky: 'KY',
	louisiana: 'LA',
	maine: 'ME',
	maryland: 'MD',
	massachusetts: 'MA',
	michigan: 'MI',
	minnesota: 'MN',
	mississippi: 'MS',
	missouri: 'MO',
	montana: 'MT',
	nebraska: 'NE',
	nevada: 'NV',
	'new hampshire': 'NH',
	'new jersey': 'NJ',
	'new mexico': 'NM',
	'new york': 'NY',
	'north carolina': 'NC',
	'north dakota': 'ND',
	ohio: 'OH',
	oklahoma: 'OK',
	oregon: 'OR',
	pennsylvania: 'PA',
	'rhode island': 'RI',
	'south carolina': 'SC',
	'south dakota': 'SD',
	tennessee: 'TN',
	texas: 'TX',
	utah: 'UT',
	vermont: 'VT',
	virginia: 'VA',
	washington: 'WA',
	'west virginia': 'WV',
	wisconsin: 'WI',
	wyoming: 'WY',
	'american samoa': 'AS',
	guam: 'GU',
	'northern mariana islands': 'MP',
	'puerto rico': 'PR',
	'u.s. virgin islands': 'VI',
	'virgin islands': 'VI',
};

const STATE_CODES = new Set(Object.values(STATE_NAME_TO_CODE));
const US_COUNTRY_PATTERN = /^(?:us|u\.s\.|usa|united states(?: of america)?)$/i;

type LocationRecord = {
	text: string;
	city: string;
	state: string;
	postalCode: string;
	country: string;
};

function stringifyValue(value: unknown) {
	return String(value || '').trim();
}

function normalizeText(value: unknown) {
	return stringifyValue(value).toLowerCase();
}

function normalizePostalDigits(value: unknown) {
	return stringifyValue(value).replace(/\D/g, '');
}

function parseAddressObject(value: unknown): Record<string, any> | null {
	if (!value) return null;
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === 'object' ? parsed : null;
		} catch {
			return null;
		}
	}
	return typeof value === 'object' ? (value as Record<string, any>) : null;
}

function createLocationRecord(input: Record<string, any>) {
	const street1 = stringifyValue(input.street1 || input.address1 || input.street);
	const street2 = stringifyValue(input.street2 || input.address2 || input.suite || input.unit);
	const city = stringifyValue(input.city || input.branch_city || input.officeCity);
	const state = stringifyValue(input.state || input.stateCode || input.branch_state || input.officeState || input.province);
	const postalCode = stringifyValue(input.postalCode || input.zipCode || input.zip || input.branch_zip);
	const country = stringifyValue(input.country);
	const text = [street1, street2, city, state, postalCode, country].filter(Boolean).join(', ');
	if (!text && !city && !state && !postalCode && !country) return null;
	return { text, city, state, postalCode, country };
}

function addRecord(records: LocationRecord[], seen: Set<string>, record: LocationRecord | null) {
	if (!record) return;
	const key = [normalizeText(record.text), normalizeText(record.city), normalizeText(record.state), normalizeText(record.postalCode), normalizeText(record.country)].join('|');
	if (!key || seen.has(key)) return;
	seen.add(key);
	records.push(record);
}

function addStructuredAddress(records: LocationRecord[], seen: Set<string>, value: unknown) {
	const parsed = parseAddressObject(value);
	if (!parsed) return;

	if (parsed.officeAddress || parsed.office || parsed.mailingAddress || parsed.mailing) {
		addStructuredAddress(records, seen, parsed.officeAddress || parsed.office);
		addStructuredAddress(records, seen, parsed.mailingAddress || parsed.mailing);
		return;
	}

	addRecord(records, seen, createLocationRecord(parsed));
}

export function normalizeStateCode(value: unknown) {
	const trimmed = stringifyValue(value);
	if (!trimmed) return '';
	const upper = trimmed.toUpperCase();
	if (STATE_CODES.has(upper)) return upper;
	return STATE_NAME_TO_CODE[trimmed.toLowerCase()] || '';
}

export function normalizeLocationStateFilter(value: unknown) {
	const trimmed = stringifyValue(value).toUpperCase();
	if (!trimmed) return '';
	if (trimmed === 'INT' || trimmed === 'INTERNATIONAL') return 'INT';
	return normalizeStateCode(trimmed);
}

export function isValidLocationStateFilter(value: unknown) {
	const trimmed = stringifyValue(value);
	if (!trimmed) return true;
	return Boolean(normalizeLocationStateFilter(trimmed));
}

export function isZipLikeLocationQuery(value: unknown) {
	return /^\d{5}(?:-\d{4})?$/.test(stringifyValue(value));
}

export function isInternationalLocationRecord(record: Pick<LocationRecord, 'text' | 'state' | 'postalCode' | 'country'>) {
	const country = stringifyValue(record.country);
	if (country && !US_COUNTRY_PATTERN.test(country)) return true;

	const rawState = stringifyValue(record.state);
	if (rawState && !normalizeStateCode(rawState)) return true;

	const postal = stringifyValue(record.postalCode);
	if (postal && /[A-Za-z]/.test(postal)) return true;

	const text = stringifyValue(record.text);
	if (text) {
		if (/\b(canada|england|ireland|scotland|wales|australia|new zealand|mexico|germany|france|switzerland|singapore|hong kong|japan)\b/i.test(text)) {
			return true;
		}
		if (!rawState && /\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/i.test(text)) {
			return true;
		}
	}

	return false;
}

export function collectNodeLocationRecords(node: any) {
	const records: LocationRecord[] = [];
	const seen = new Set<string>();

	addStructuredAddress(records, seen, node?.firmAddressDetails);
	addStructuredAddress(records, seen, node?.iaFirmAddressDetails);
	addStructuredAddress(records, seen, node?.firm_address_details);
	addStructuredAddress(records, seen, node?.address_details);
	addStructuredAddress(records, seen, node?.basicInformation?.firmAddressDetails);
	addStructuredAddress(records, seen, node?.basicInformation?.iaFirmAddressDetails);
	addStructuredAddress(records, seen, node?.primaryOffice);

	if (typeof node?.officeAddress === 'string') {
		addRecord(
			records,
			seen,
			createLocationRecord({
				address1: node.officeAddress,
			}),
		);
	} else {
		addStructuredAddress(records, seen, node?.officeAddress);
	}

	const employmentCollections = [
		node?.currentEmployments,
		node?.previousEmployments,
		node?.currentIAEmployments,
		node?.previousIAEmployments,
		node?.ind_current_employments,
		node?.ind_previous_employments,
		node?.ind_ia_current_employments,
		node?.ind_ia_previous_employments,
		node?.branchOfficeLocations,
	];

	for (const collection of employmentCollections) {
		for (const entry of Array.isArray(collection) ? collection : []) {
			addRecord(records, seen, createLocationRecord(entry || {}));
		}
	}

	return records;
}

export function nodeMatchesLocationSearch(
	node: any,
	{ locationQuery = '', stateFilter = '' }: { locationQuery?: string; stateFilter?: string } = {},
) {
	const normalizedQuery = normalizeText(locationQuery);
	const normalizedState = normalizeLocationStateFilter(stateFilter);
	if (!normalizedQuery && !normalizedState) return false;

	const queryZipDigits = normalizePostalDigits(locationQuery);
	const queryLooksLikeZip = isZipLikeLocationQuery(locationQuery);
	const records = collectNodeLocationRecords(node);
	if (!records.length) return false;

	return records.some((record) => {
		const recordState = normalizeStateCode(record.state);
		const isInternational = isInternationalLocationRecord(record);

		if (normalizedState === 'INT') {
			if (!isInternational) return false;
		} else if (normalizedState && recordState !== normalizedState) {
			return false;
		}

		if (!normalizedQuery) return true;

		if (queryLooksLikeZip) {
			const recordZipDigits = normalizePostalDigits(record.postalCode);
			return Boolean(recordZipDigits) && recordZipDigits.startsWith(queryZipDigits);
		}

		const haystacks = [record.text, record.city, record.postalCode, record.country].map(normalizeText).filter(Boolean);
		return haystacks.some((value) => value.includes(normalizedQuery));
	});
}
