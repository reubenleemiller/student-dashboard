// js/calendar.js
// Pure-JS month calendar component. No external dependencies.

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

export class BookingCalendar {
  /**
   * @param {HTMLElement} container - element to render into
   * @param {Array}       bookings  - array of booking objects with start_time, status
   * @param {Function}    [onDayClick] - optional callback(date, bookingsForDay)
   */
  constructor(container, bookings, onDayClick) {
    this.container   = container;
    this.bookings    = bookings || [];
    this.onDayClick  = onDayClick || null;
    this.today       = new Date();
    this.year        = this.today.getFullYear();
    this.month       = this.today.getMonth();
    this.render();
  }

  /** Replace bookings and re-render. */
  update(bookings) {
    this.bookings = bookings || [];
    this.render();
  }

  /** Return bookings whose start_time falls on the given local date. */
  bookingsForDate(date) {
    return this.bookings.filter(b => {
      const d = new Date(b.start_time);
      return d.getFullYear() === date.getFullYear() &&
             d.getMonth()    === date.getMonth() &&
             d.getDate()     === date.getDate();
    });
  }

  render() {
    const firstDay = new Date(this.year, this.month, 1);
    const lastDay  = new Date(this.year, this.month + 1, 0);

    let html = `
      <div class="calendar">
        <div class="calendar-header">
          <button class="btn btn-ghost btn-sm" id="cal-prev">&#8249;</button>
          <h3>${MONTH_NAMES[this.month]} ${this.year}</h3>
          <button class="btn btn-ghost btn-sm" id="cal-next">&#8250;</button>
        </div>
        <div class="calendar-grid">
          ${DAY_NAMES.map(d => `<div class="cal-day-header">${d}</div>`).join('')}
    `;

    // Leading empty cells
    for (let i = 0; i < firstDay.getDay(); i++) {
      html += '<div class="cal-day empty"></div>';
    }

    // Day cells
    for (let d = 1; d <= lastDay.getDate(); d++) {
      const date    = new Date(this.year, this.month, d);
      const bk      = this.bookingsForDate(date);
      const isToday = date.toDateString() === this.today.toDateString();
      const isPast  = date < this.today && !isToday;

      let cls = 'cal-day';
      if (isToday)  cls += ' today';
      if (isPast)   cls += ' past';
      if (bk.length) cls += ' has-bookings';

      const dotsHtml = bk.map(b =>
        `<div class="booking-dot ${b.status !== 'scheduled' ? b.status : ''}" title="${new Date(b.start_time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} – ${b.event_type || 'Session'} (${b.status})"></div>`
      ).join('');

      html += `
        <div class="${cls}" data-date="${date.toISOString()}">
          <span class="day-number">${d}</span>
          ${bk.length ? `<div class="booking-dots">${dotsHtml}</div>` : ''}
        </div>
      `;
    }

    html += '</div></div>';
    this.container.innerHTML = html;

    // Wire up navigation
    this.container.querySelector('#cal-prev').addEventListener('click', () => {
      if (this.month === 0) { this.month = 11; this.year--; }
      else                  { this.month--; }
      this.render();
    });
    this.container.querySelector('#cal-next').addEventListener('click', () => {
      if (this.month === 11) { this.month = 0; this.year++; }
      else                   { this.month++; }
      this.render();
    });

    // Day click
    if (this.onDayClick) {
      this.container.querySelectorAll('.cal-day.has-bookings').forEach(el => {
        el.addEventListener('click', () => {
          const date     = new Date(el.dataset.date);
          const dayBk    = this.bookingsForDate(date);
          this.onDayClick(date, dayBk);
        });
      });
    }
  }
}
