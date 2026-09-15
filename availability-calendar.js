(function () {
  const app = document.querySelector('.availability-calendar-app');
  if (!app) return;

  const monthLabel = app.querySelector('[data-calendar-month]');
  const grid = app.querySelector('[data-calendar-grid]');
  const status = app.querySelector('[data-calendar-status]');
  const prevButton = app.querySelector('[data-calendar-prev]');
  const nextButton = app.querySelector('[data-calendar-next]');
  const apiPath = app.dataset.calendarApi;
  const locale = app.dataset.calendarLocale === 'ru' ? 'ru' : 'en';
  const copy = locale === 'ru' ? {
    monthNames: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'],
    weekdayNames: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
    weekdayNamesLong: ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'],
    stateLabels: {
      available: 'свободно',
      booked: 'занято весь день',
      'booked-am': 'занято утром',
      'booked-pm': 'занято днём',
      unknown: 'доступность не загружена'
    },
    loading: 'Загрузка доступности…',
    error: 'Доступность временно недоступна. Пожалуйста, свяжитесь с Софией.',
    updated: 'Обновлено: ',
    timeLocale: 'ru-CA',
    gridLabel: 'Календарь доступности'
  } : {
    monthNames: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    weekdayNames: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    weekdayNamesLong: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    stateLabels: {
      available: 'available',
      booked: 'booked all day',
      'booked-am': 'booked in the morning',
      'booked-pm': 'booked in the afternoon',
      unknown: 'availability not loaded'
    },
    loading: 'Loading availability…',
    error: 'Availability is temporarily unavailable. Please contact Sofia.',
    updated: 'Updated: ',
    timeLocale: 'en-CA',
    gridLabel: 'Availability calendar'
  };

  const today = new Date();
  let displayedMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  let availability = new Map();
  let dataLoaded = false;
  let requestId = 0;

  if (grid) grid.setAttribute('aria-label', copy.gridLabel);

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function formatDate(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function monthRange(month) {
    const start = new Date(month.getFullYear(), month.getMonth(), 1);
    const end = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    return { start: formatDate(start), end: formatDate(end) };
  }

  function setStatus(message, isError) {
    status.textContent = message;
    status.classList.toggle('is-error', Boolean(isError));
  }

  function appendEmptyCell() {
    const empty = document.createElement('div');
    empty.className = 'calendar-day is-empty';
    empty.setAttribute('role', 'gridcell');
    empty.setAttribute('aria-hidden', 'true');
    grid.appendChild(empty);
  }

  function render(month) {
    monthLabel.textContent = copy.monthNames[month.getMonth()] + ' ' + month.getFullYear();
    grid.replaceChildren();

    copy.weekdayNames.forEach(function (name, index) {
      const heading = document.createElement('div');
      heading.className = 'calendar-weekday';
      heading.setAttribute('role', 'columnheader');
      const shortName = document.createElement('span');
      shortName.className = 'weekday-short';
      shortName.textContent = name;
      const longName = document.createElement('span');
      longName.className = 'weekday-long';
      longName.textContent = copy.weekdayNamesLong[index];
      heading.appendChild(shortName);
      heading.appendChild(longName);
      grid.appendChild(heading);
    });

    const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
    const offset = (firstDay.getDay() + 6) % 7;
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const totalDateCells = Math.ceil((offset + daysInMonth) / 7) * 7;

    for (let i = 0; i < offset; i += 1) appendEmptyCell();

    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(month.getFullYear(), month.getMonth(), day);
      const key = formatDate(date);
      const state = dataLoaded ? (availability.get(key) || 'available') : 'unknown';
      const cell = document.createElement('div');
      const number = document.createElement('span');
      cell.className = 'calendar-day state-' + state;
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', day + ' ' + copy.monthNames[month.getMonth()] + ' ' + month.getFullYear() + ', ' + copy.stateLabels[state]);
      cell.dataset.date = key;
      number.className = 'calendar-day-number';
      number.textContent = day;
      cell.appendChild(number);
      grid.appendChild(cell);
    }

    while (grid.children.length - copy.weekdayNames.length < totalDateCells) appendEmptyCell();
  }

  async function loadMonth(month) {
    const currentRequest = ++requestId;
    const range = monthRange(month);
    setStatus(copy.loading, false);
    availability = new Map();
    dataLoaded = false;
    render(month);

    try {
      const response = await fetch(apiPath + '?start=' + encodeURIComponent(range.start) + '&end=' + encodeURIComponent(range.end), { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Calendar request failed');
      const payload = await response.json();
      if (!payload || !Array.isArray(payload.days)) throw new Error('Invalid calendar response');
      if (currentRequest !== requestId) return;
      payload.days.forEach(function (item) {
        if (item && /^\d{4}-\d{2}-\d{2}$/.test(item.date) && copy.stateLabels[item.state]) availability.set(item.date, item.state);
      });
      dataLoaded = true;
      setStatus(copy.updated + new Date().toLocaleTimeString(copy.timeLocale, { hour: '2-digit', minute: '2-digit' }), false);
      render(month);
    } catch (error) {
      if (currentRequest !== requestId) return;
      setStatus(copy.error, true);
      render(month);
    }
  }

  prevButton.addEventListener('click', function () {
    displayedMonth = new Date(displayedMonth.getFullYear(), displayedMonth.getMonth() - 1, 1);
    loadMonth(displayedMonth);
  });
  nextButton.addEventListener('click', function () {
    displayedMonth = new Date(displayedMonth.getFullYear(), displayedMonth.getMonth() + 1, 1);
    loadMonth(displayedMonth);
  });
  loadMonth(displayedMonth);
}());
