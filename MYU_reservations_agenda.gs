// =====================================================================
// MYU — Réservations par créneaux : agenda Google + feuille (ajout 02/10/2026)
// =====================================================================
// Deux actions appelées par le serveur du site (missu-two.vercel.app) :
//
//  GET  ?action=busy&from=ISO&to=ISO&ignore=mot1|mot2
//       -> plages OCCUPÉES de l'agenda principal d'Astrid (début/fin uniquement,
//          jamais le contenu des événements). Ignorés : événements "Disponible",
//          invitations refusées, et événements dont le titre/lieu contient un
//          des mots ignorés (ex. cours de Mathéo au Collège Édouard Glissant).
//
//  POST { action: 'syncBooking', rdvId }
//       -> relit la réservation DIRECTEMENT auprès du serveur MYU (jamais à
//          partir des données envoyées), puis :
//          * crée / met à jour / retire l'événement de l'agenda principal
//            (retrouvé par son identifiant de réservation : aucun doublon) ;
//          * crée / met à jour la ligne de la feuille (retrouvée par rdv_id,
//            puis par n° de dossier) avec jour, horaire, lieu et paiement.
//
// Sécurité : l'action syncBooking ne fait confiance à AUCUNE donnée reçue ;
// elle n'utilise que la réponse du serveur MYU (URL fixe ci-dessous).
// =====================================================================

const MYU_SITE_ORIGIN = 'https://missu-two.vercel.app';
const MYU_TZ = 'America/Martinique';
const MYU_EVENT_TAG = 'myu_rdv';
const MYU_BOOKING_HEADERS = ['rdv_id', 'horaire', 'paiement'];

function handleBusy_(p) {
  const from = new Date(p.from);
  const to = new Date(p.to);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from || (to - from) > 62 * 86400000) {
    return { ok: false, error: 'Plage invalide.' };
  }
  const ignore = String(p.ignore || '').split('|').map(function (s) { return s.trim().toLowerCase(); }).filter(String);
  const cal = CalendarApp.getDefaultCalendar();
  const tz = cal.getTimeZone() || MYU_TZ;
  const busy = [];
  cal.getEvents(from, to).forEach(function (ev) {
    try {
      if (typeof ev.getTransparency === 'function' && String(ev.getTransparency()) === 'TRANSPARENT') return;
    } catch (e) { /* propriété indisponible : l'événement est considéré occupé */ }
    try {
      if (String(ev.getMyStatus()) === 'NO') return;
    } catch (e) { /* événement sans invités */ }
    const hay = (String(ev.getTitle() || '') + ' ' + String(ev.getLocation() || '')).toLowerCase();
    for (var i = 0; i < ignore.length; i++) {
      if (hay.indexOf(ignore[i]) !== -1) return;
    }
    const tag = ev.getTag(MYU_EVENT_TAG) || null;
    if (ev.isAllDayEvent()) {
      busy.push({
        allDay: true,
        startDate: Utilities.formatDate(ev.getAllDayStartDate(), tz, 'yyyy-MM-dd'),
        endDate: Utilities.formatDate(ev.getAllDayEndDate(), tz, 'yyyy-MM-dd'),
        myuRdv: tag,
      });
    } else {
      busy.push({ start: ev.getStartTime().toISOString(), end: ev.getEndTime().toISOString(), myuRdv: tag });
    }
  });
  return { ok: true, busy: busy };
}

function fetchBookingFromServer_(rdvId) {
  if (!/^[0-9a-f-]{36}$/i.test(rdvId)) throw new Error('Référence de réservation invalide.');
  const res = UrlFetchApp.fetch(MYU_SITE_ORIGIN + '/api/booking?action=status&scope=sync&id=' + encodeURIComponent(rdvId), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Serveur MYU : réponse ' + res.getResponseCode());
  const body = JSON.parse(res.getContentText());
  if (!body || !body.success || !body.data) throw new Error('Serveur MYU : réservation introuvable.');
  return body.data;
}

function handleSyncBooking_(d) {
  const rdvId = String(d.rdvId || '');
  const b = fetchBookingFromServer_(rdvId);
  const out = { ok: true };
  try { out.calendar = upsertBookingEvent_(b); } catch (err) { out.calendarError = String(err && err.message || err); }
  try { out.sheet = upsertBookingRow_(b, out); } catch (err) { out.sheetError = String(err && err.message || err); }
  return out;
}

function bookingTitle_(b) {
  return (b.prestation + ' – ' + [b.prenom, b.nom].filter(String).join(' ')).trim();
}

function findBookingEvent_(cal, b) {
  const center = b.debutIso ? new Date(b.debutIso) : new Date();
  const from = new Date(center.getTime() - 90 * 86400000);
  const to = new Date(center.getTime() + 90 * 86400000);
  // Recherche d'abord par identifiant d'événement mémorisé, puis par étiquette.
  if (b.agenda && b.agenda.evenementId) {
    try {
      const ev = cal.getEventById(b.agenda.evenementId);
      if (ev) return ev;
    } catch (e) { /* événement supprimé à la main */ }
  }
  const evs = cal.getEvents(from, to, { search: b.id });
  for (var i = 0; i < evs.length; i++) {
    if (evs[i].getTag(MYU_EVENT_TAG) === b.id) return evs[i];
  }
  return null;
}

function upsertBookingEvent_(b) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cal = CalendarApp.getDefaultCalendar();
    const existing = findBookingEvent_(cal, b);
    if (b.agendaAction === 'remove' || b.agendaAction === 'none') {
      if (existing && b.agendaAction === 'remove') { existing.deleteEvent(); return { action: 'removed' }; }
      return { action: 'absent' };
    }
    const start = new Date(b.debutIso);
    const end = new Date(b.finIso);
    const description = [
      'Réservation MYU ' + (b.dossierId || '') + ' — ' + b.statutLibelle,
      b.paiement && b.paiement.libelle ? b.paiement.libelle : '',
      b.telephone ? 'Tél : ' + b.telephone : '',
      b.email ? 'Email : ' + b.email : '',
      'Réf. réservation : ' + b.id,
    ].filter(String).join('\n');
    var ev = existing;
    if (ev) {
      ev.setTime(start, end);
      ev.setTitle(bookingTitle_(b));
      ev.setLocation(b.lieu || '');
      // Conserve les notes écrites à la main dans l'événement : seul le bloc MYU est remplacé.
      const prev = String(ev.getDescription() || '');
      const cut = prev.indexOf('Réservation MYU ');
      const notes = (cut === -1 ? prev : prev.slice(0, cut)).trim();
      ev.setDescription(notes ? notes + '\n\n' + description : description);
      if (ev.getTag(MYU_EVENT_TAG) !== b.id) ev.setTag(MYU_EVENT_TAG, b.id);
    } else {
      ev = cal.createEvent(bookingTitle_(b), start, end, { location: b.lieu || '', description: description });
      ev.setTag(MYU_EVENT_TAG, b.id);
    }
    // Code couleur d'Astrid : rendez-vous clientes MYU en rose.
    try { ev.setColor(CalendarApp.EventColor.PALE_RED); } catch (e) { /* couleur facultative */ }
    return { action: existing ? 'updated' : 'created', eventId: ev.getId() };
  } finally {
    lock.releaseLock();
  }
}

function ensureBookingHeaders_(sheet) {
  const cols = headerIndex_(sheet);
  MYU_BOOKING_HEADERS.forEach(function (h) {
    if (!cols[h]) {
      const c = sheet.getLastColumn() + 1;
      sheet.getRange(1, c).setValue(h);
    }
  });
  return headerIndex_(sheet);
}

function findRowByCol_(sheet, col, value) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2 || !col || !value) return -1;
  const vals = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === String(value)) return i + 2;
  }
  return -1;
}

function nextIdUnlocked_() {
  const props = PropertiesService.getScriptProperties();
  const n = parseInt(props.getProperty('lastClientNumber') || '0', 10) + 1;
  props.setProperty('lastClientNumber', String(n));
  return ID_PREFIX + String(n).padStart(5, '0');
}

function upsertBookingRow_(b, syncResult) {
  if (b.feuilleAction !== 'upsert') return { action: 'ignored' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getSheet_();
    const cols = ensureBookingHeaders_(sheet);
    var rowNum = findRowByCol_(sheet, cols['rdv_id'], b.id);
    if (rowNum === -1 && b.dossierId) rowNum = findRowByCol_(sheet, cols['id'], b.dossierId);
    const created = rowNum === -1;
    var dossierId = b.dossierId;
    if (created) {
      dossierId = dossierId || nextIdUnlocked_();
      const row = new Array(sheet.getLastColumn()).fill('');
      row[cols['createdAt'] - 1] = new Date();
      row[cols['id'] - 1] = dossierId;
      row[cols['consentToken'] - 1] = Utilities.getUuid();
      row[cols['consentement_rempli'] - 1] = 'Non';
      sheet.appendRow(row);
      rowNum = sheet.getLastRow();
    } else if (!dossierId) {
      dossierId = sheet.getRange(rowNum, cols['id']).getValue();
    }
    const set = function (name, value) {
      if (cols[name] && value !== undefined && value !== null) sheet.getRange(rowNum, cols[name]).setValue(value);
    };
    const setIfFilled = function (name, value) { if (value) set(name, value); };
    set('rdv_id', b.id);
    if (!sheet.getRange(rowNum, cols['id']).getValue()) set('id', dossierId);
    setIfFilled('NOM', b.prenom);       // convention existante : prénom en colonne "NOM"
    setIfFilled('lPRENOM', b.nom);      // et nom en colonne "lPRENOM"
    setIfFilled('phone', b.telephone);
    setIfFilled('email', b.email);
    set('services', b.prestation);
    set('lieu', b.lieu || '');
    // Texte forcé (apostrophe) pour que la feuille n'altère pas le format AAAA-MM-JJ.
    set('date', b.date ? "'" + b.date : '');
    set('periode', b.heureDebut ? (b.heureDebut < '12:00' ? 'Matin' : 'Après-midi') : '');
    set('horaire', b.heureDebut && b.heureFin ? b.heureDebut + '–' + b.heureFin : '');
    set('paiement', b.paiement ? b.paiement.libelle : '');
    set('statuts', b.statutLibelle + (b.paiement && b.paiement.statut === 'paye' ? ' (acompte payé)' : ''));
    var cal = '';
    if (syncResult && syncResult.calendar && syncResult.calendar.eventId) cal = 'Oui (app) ' + Utilities.formatDate(new Date(), MYU_TZ, 'dd/MM HH:mm');
    else if (syncResult && syncResult.calendar && syncResult.calendar.action === 'removed') cal = 'Retiré (annulé)';
    else if (syncResult && syncResult.calendarError) cal = 'Erreur (app) : ' + syncResult.calendarError.slice(0, 120);
    else cal = 'Non requis (app)';
    set('calendrier_sync', cal);
    if (created) {
      try {
        envoyerNotificationWhatsApp([b.prenom, b.nom].filter(String).join(' '), b.prestation + ' — ' + b.date + ' ' + b.heureDebut + ' (' + b.lieu + ')', b.telephone || '');
      } catch (e) { /* notification facultative */ }
    }
    return { action: created ? 'created' : 'updated', dossierId: dossierId, row: rowNum };
  } finally {
    lock.releaseLock();
  }
}

// Pré-diagnostic rempli APRÈS une réservation : complète la ligne de la
// réservation (même dossier) au lieu de créer une nouvelle ligne sans créneau.
function mergeDiagnosticIntoBooking_(d) {
  if (!d.rdvId) return null;
  const sheet = getSheet_();
  const cols = ensureBookingHeaders_(sheet);
  const rowNum = findRowByCol_(sheet, cols['rdv_id'], d.rdvId);
  if (rowNum === -1) return null;
  const get = function (name) { return sheet.getRange(rowNum, cols[name]).getValue(); };
  const photoLinks = savePhotosToDrive(d.photos, get('NOM'), get('lPRENOM'));
  if (photoLinks) {
    const prev = String(get('photoLinks') || '');
    sheet.getRange(rowNum, cols['photoLinks']).setValue(prev ? prev + ' | ' + photoLinks : photoLinks);
  }
  if (d.contraindications) sheet.getRange(rowNum, cols['contre-indications']).setValue(d.contraindications);
  if (d.notes) {
    const prevNotes = String(get('notes') || '');
    sheet.getRange(rowNum, cols['notes']).setValue(prevNotes ? prevNotes + ' | ' + d.notes : d.notes);
  }
  if (d.city && !get('VILLE')) sheet.getRange(rowNum, cols['VILLE']).setValue(d.city);
  return { ok: true, id: get('id'), consentToken: get('consentToken'), merged: true };
}
