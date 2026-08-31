// api/routes/trainer.js — портал тренера глазами спортсмена («мои записи»).
//
// Фабрика: принимает зависимости и возвращает [{ method, path, handler }].
// Вынесено из монолита server.js — поведение идентично (импорт, не копия).
// Это не админ-панель тренера (она в admin.js): здесь спортсмен видит своего
// тренера, его часы работы, свободные окна и свои записи (request/cancel).
export function createTrainerRoutes(deps) {
  const {
    json, readBody, readSession,
    adminDbReady, listTrainerAssignments, listAdmins,
    getTrainerAvailability, rollRecurringForward, listBookings,
    findBookingConflict, createBooking, getBooking, updateBookingStatus,
    localToday, timeInRange,
    saveNotification, sendPush
  } = deps;

  return [
  /* ---------- trainer booking (athlete side) ---------- */

  // My assigned trainer.
  { method: 'GET', path: '/api/trainer/me', handler: async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try {
      await adminDbReady;
      const ta = await listTrainerAssignments();
      const row = ta.find(x => x.user_id === user.id);
      if (!row) return json(res, 200, { trainer: null });
      const admins = await listAdmins();
      const trainer = admins.find(a => a.id === row.trainer_id);
      json(res, 200, { trainer: trainer ? { id: trainer.id, name: trainer.name } : null });
    } catch (error) {
      console.error('trainer/me failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  } },

  // My trainer's working hours + already-taken upcoming slots.
  { method: 'GET', path: '/api/trainer/availability', handler: async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try {
      await adminDbReady;
      const ta = await listTrainerAssignments();
      const row = ta.find(x => x.user_id === user.id);
      if (!row) return json(res, 200, { availability: [], taken: [] });
      const availability = await getTrainerAvailability(row.trainer_id);
      await rollRecurringForward(row.trainer_id); // refresh materialized "постоянные" slots
      const bookings = await listBookings({ trainerId: row.trainer_id, from: localToday() });
      const taken = bookings.filter(b => b.status === 'pending' || b.status === 'confirmed')
        .map(b => ({ date: b.date, time: b.time }));
      json(res, 200, { availability, taken });
    } catch (error) {
      console.error('trainer availability failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  } },

  // Request a session (status = pending until the trainer confirms).
  { method: 'POST', path: '/api/trainer/book', handler: async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const date = String(body.date || '');
    const time = String(body.time || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
      return json(res, 400, { error: 'date and time required' });
    try {
      await adminDbReady;
      const ta = await listTrainerAssignments();
      const row = ta.find(x => x.user_id === user.id);
      if (!row) return json(res, 403, { error: 'no trainer assigned' });
      if (date < localToday()) return json(res, 400, { error: 'date is in the past' });
      const availability = await getTrainerAvailability(row.trainer_id);
      const wd = new Date(date + 'T12:00:00').getDay();
      const inHours = availability.some(a => a.weekday === wd && timeInRange(time, a.time_start, a.time_end));
      if (!inHours) return json(res, 400, { error: 'time outside working hours' });
      const conflict = await findBookingConflict(row.trainer_id, date, time);
      if (conflict) return json(res, 409, { error: 'this slot is already booked' });
      const booking = await createBooking({ trainerId: row.trainer_id, athleteId: user.id, date, time, note: body.note, status: 'pending' });
      // the request lands in the trainer's notification center (same table as athletes)
      try {
        await saveNotification({
          id: 'tbk-' + booking.id, userId: 'admin:' + row.trainer_id,
          title: 'Новая заявка на тренировку',
          body: (user.name || 'Спортсмен') + ' · ' + String(booking.date).slice(8, 10) + '.' + String(booking.date).slice(5, 7) + ' · ' + booking.time
            + (body.note ? ' — ' + String(body.note).slice(0, 120) : ''),
          payload: { booking_id: booking.id, status: 'pending', date: booking.date, time: booking.time, kind: 'booking' }
        });
      } catch (e) { console.error('trainer booking notif save failed:', e.message); }
      // push alert to the trainer (no-op if they haven't subscribed from the portal)
      await sendPush('admin:' + row.trainer_id, {
        title: 'Новая заявка на тренировку',
        body: user.name + ' · ' + date + ' ' + time + (body.note ? ' — ' + String(body.note).slice(0, 120) : ''),
        tag: 'booking-' + booking.id,
        data: { booking_id: booking.id }
      }).catch(e => console.error('trainer booking push failed:', e.message));
      json(res, 200, { ok: true, booking });
    } catch (error) {
      console.error('trainer book failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  } },

  // My own bookings.
  { method: 'GET', path: '/api/trainer/my-bookings', handler: async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try {
      await adminDbReady;
      const ta = await listTrainerAssignments();
      const trow = ta.find(x => x.user_id === user.id);
      if (trow) await rollRecurringForward(trow.trainer_id);
      const bookings = await listBookings({ athleteId: user.id });
      json(res, 200, { bookings });
    } catch (error) {
      console.error('trainer my-bookings failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  } },

  // Athlete cancels one of their own pending/confirmed bookings.
  { method: 'POST', path: '/api/trainer/bookings/cancel', handler: async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    try {
      await adminDbReady;
      const booking = await getBooking(String(body.id || ''));
      if (!booking || booking.athlete_id !== user.id) return json(res, 404, { error: 'no such booking' });
      if (booking.status !== 'pending' && booking.status !== 'confirmed')
        return json(res, 400, { error: 'booking cannot be cancelled' });
      const updated = await updateBookingStatus({ id: booking.id, status: 'cancelled' });
      json(res, 200, { ok: true, booking: updated });
    } catch (error) {
      console.error('trainer cancel failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  } },
  ];
}
