// NZ tax due dates, server-side copy for the notification feed.
//
// The Calendar view keeps its own copy in calendar.js (a classic script —
// it cannot import this module). When you add a year, update both.

export const NZ_TAX = {
    '2025-02-28': ['GST Return due'],
    '2025-04-28': ['GST Return due'],
    '2025-05-07': ['Provisional Tax (3rd)'],
    '2025-06-28': ['GST Return due'],
    '2025-08-28': ['GST Return due', 'Provisional Tax (1st)'],
    '2025-10-28': ['GST Return due'],
    '2025-12-28': ['GST Return due'],
    '2026-01-15': ['Provisional Tax (2nd)'],
    '2026-02-28': ['GST Return due'],
    '2026-04-28': ['GST Return due'],
    '2026-05-07': ['Provisional Tax (3rd)'],
    '2026-06-28': ['GST Return due'],
    '2026-07-07': ['Income Tax Return due'],
    '2026-08-28': ['GST Return due', 'Provisional Tax (1st)'],
    '2026-10-28': ['GST Return due'],
    '2026-12-28': ['GST Return due'],
};
