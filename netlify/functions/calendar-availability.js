const ICS_URL = 'https://calendar.google.com/calendar/ical/c32ab8b880a68ef9869fa117eb13963d6594772c99854d003a67405fc00f7c6e%40group.calendar.google.com/public/basic.ics';
const TIME_ZONE = 'America/Toronto';
const CACHE_TTL_MS = 5 * 60 * 1000;

const TITLE_STATES = new Map([
  ['booked', 'booked'],
  ['booked am', 'booked-am'],
  ['booked pm', 'booked-pm'],
  ['booked from 3pm', 'booked-pm'],
  ['booked from 3 pm', 'booked-pm'],
  ['booked till 11am', 'booked-am'],
  ['booked till 11 am', 'booked-am'],
  ['booked till 3pm', 'booked-am'],
  ['booked till 3 pm', 'booked-am']
]);

let feedCache = { expiresAt: 0, text: null };
const resultCache = new Map();

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=600'
    },
    body: JSON.stringify(body)
  };
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === value;
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function decodeText(value) {
  return String(value || '').replace(/\\([nN\\,;])/g, (match, code) => {
    if (code.toLowerCase() === 'n') return '\n';
    return code;
  });
}

function unfoldLines(text) {
  const physicalLines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const logicalLines = [];
  physicalLines.forEach((line) => {
    if (/^[ \t]/.test(line)) {
      if (!logicalLines.length) throw new Error('ICS continuation line has no preceding line');
      logicalLines[logicalLines.length - 1] += line.slice(1);
    } else if (line !== '') {
      logicalLines.push(line);
    }
  });
  return logicalLines;
}

function parseProperty(line) {
  const separator = line.indexOf(':');
  if (separator <= 0) throw new Error(`Malformed ICS property: ${line}`);

  const left = line.slice(0, separator).split(';');
  const name = left.shift().toUpperCase();
  const parameters = {};
  left.forEach((parameter) => {
    const equals = parameter.indexOf('=');
    if (equals <= 0) throw new Error(`Malformed ICS parameter: ${line}`);
    const key = parameter.slice(0, equals).toUpperCase();
    const value = parameter.slice(equals + 1).replace(/^"|"$/g, '');
    parameters[key] = value;
  });

  return { name, parameters, value: line.slice(separator + 1) };
}

function parseCalendar(text) {
  const lines = unfoldLines(text);
  if (!lines.includes('BEGIN:VCALENDAR') || !lines.includes('END:VCALENDAR')) throw new Error('Invalid ICS calendar envelope');

  const events = [];
  let current = null;
  lines.forEach((line) => {
    if (line === 'BEGIN:VEVENT') {
      if (current) throw new Error('Nested VEVENT in ICS feed');
      current = [];
      return;
    }
    if (line === 'END:VEVENT') {
      if (!current) throw new Error('Unexpected END:VEVENT in ICS feed');
      events.push(current);
      current = null;
      return;
    }
    if (current) current.push(parseProperty(line));
  });

  if (current) throw new Error('Unclosed VEVENT in ICS feed');
  return events;
}

function property(event, name) {
  return event.find((item) => item.name === name);
}

function hasRecurrence(event) {
  return event.some((item) => ['RRULE', 'RDATE', 'EXDATE', 'RECURRENCE-ID'].includes(item.name));
}

function dateTimeToTorontoDate(value) {
  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  const instant = new Date(`${year}-${month}-${day}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(instant).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseDateProperty(item) {
  if (!item) return null;
  const value = item.value.trim();
  if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (/^\d{8}T\d{6}Z$/.test(value)) return dateTimeToTorontoDate(value);
  if (/^\d{8}T\d{6}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  throw new Error(`Unsupported ICS date value: ${value}`);
}

function classifyTitle(summary) {
  const normalized = decodeText(summary).trim().toLowerCase().replace(/\s+/g, ' ');
  if (TITLE_STATES.has(normalized)) return { state: TITLE_STATES.get(normalized) };
  if (normalized.startsWith('booked')) return { state: 'booked', unrecognized: normalized };
  return null;
}

function mergeState(previous, next) {
  if (!previous || previous === 'available') return next;
  if (previous === 'booked' || next === 'booked') return 'booked';
  if (previous !== next) return 'booked';
  return previous;
}

function normalizeEvents(text, start, end) {
  const events = parseCalendar(text);
  const states = new Map();
  const warnings = new Set();

  events.forEach((event) => {
    const status = property(event, 'STATUS');
    if (status && status.value.trim().toUpperCase() === 'CANCELLED') return;
    if (hasRecurrence(event)) throw new Error('Recurring ICS events are not supported safely');

    const title = classifyTitle(property(event, 'SUMMARY')?.value);
    if (!title) return;
    if (title.unrecognized) warnings.add(title.unrecognized);

    const eventStartProperty = property(event, 'DTSTART');
    const eventStart = parseDateProperty(eventStartProperty);
    if (!eventStart || !isValidDate(eventStart)) throw new Error('Relevant ICS event has an invalid DTSTART');

    const eventEndProperty = property(event, 'DTEND');
    const eventEndExclusive = eventEndProperty ? parseDateProperty(eventEndProperty) : nextDate(eventStart);
    if (!isValidDate(eventEndExclusive) || eventEndExclusive <= eventStart) throw new Error('Relevant ICS event has an invalid DTEND');

    const firstDate = eventStart < start ? start : eventStart;
    const exclusiveEnd = eventEndExclusive > end ? nextDate(end) : eventEndExclusive;
    for (let current = firstDate; current < exclusiveEnd; current = nextDate(current)) {
      states.set(current, mergeState(states.get(current), title.state));
    }
  });

  if (warnings.size) console.warn('Unrecognized Booked titles treated as full-day bookings:', [...warnings]);
  return Array.from(states.entries())
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([date, state]) => ({ date, state }));
}

async function fetchFeed() {
  const now = Date.now();
  if (feedCache.text && feedCache.expiresAt > now) return feedCache.text;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(ICS_URL, { signal: controller.signal, headers: { Accept: 'text/calendar' } });
    if (!response.ok) throw new Error(`Public ICS feed returned ${response.status}`);
    const text = await response.text();
    if (!text.includes('BEGIN:VCALENDAR') || !text.includes('END:VCALENDAR')) throw new Error('Public ICS feed is not a calendar');
    feedCache = { text, expiresAt: Date.now() + CACHE_TTL_MS };
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

exports.handler = async function handler(event) {
  const query = event.queryStringParameters || {};
  const start = query.start;
  const end = query.end;
  if (!isValidDate(start) || !isValidDate(end) || start > end) return json(400, { error: 'A valid start and end date are required.' });

  const cacheKey = `${start}:${end}`;
  const cached = resultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return json(200, { start, end, days: cached.days });

  try {
    const days = normalizeEvents(await fetchFeed(), start, end);
    resultCache.set(cacheKey, { days, expiresAt: Date.now() + CACHE_TTL_MS });
    return json(200, { start, end, days });
  } catch (error) {
    console.error('Calendar availability error:', error.message);
    return json(503, { error: 'Calendar availability is temporarily unavailable.' });
  }
};
