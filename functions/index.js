// SHBV Leads — server-side push notifications.
//
// The app itself (index.html) can only send a push while a browser tab is
// open (even in the background) and the device registered for it. These two
// Cloud Functions are the server-side half: they run on Google's servers
// and fire a REAL push — phone screen off, app fully closed, doesn't
// matter — the same way WhatsApp or Gmail notify you.
//
// 1. onLeadWritten   — fires the instant a lead is saved. If it finds a
//    brand-new assignment (a referral just handed to a salesperson), it
//    pushes "New lead referred to you" to that person, immediately.
// 2. dailyFollowUpDigest — runs once every morning (9:30am IST) and pushes
//    each salesperson a count of what's due today (follow-ups, meetings,
//    post-sale check-ins) — same idea as the in-app "due today" reminder,
//    just delivered as a real push instead of only showing while the tab
//    is open.
//
// Both reuse the exact same Firestore documents the web app already reads
// and writes (shbv_kv/lead_v2_*, shbv_kv/staff-data) — nothing about the
// app's data model changes, these functions are purely additive.

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// Mumbai region — closest to Phagwara, Punjab, keeps latency/cost down.
setGlobalOptions({ region: 'asia-south1', maxInstances: 10 });

const LEADS_V2_PREFIX = 'lead_v2_';

async function loadStaff() {
  const doc = await db.collection('shbv_kv').doc('staff-data').get();
  if (!doc.exists) return null;
  try { return JSON.parse(doc.data().value); } catch (e) { return null; }
}

async function saveStaff(staff) {
  await db.collection('shbv_kv').doc('staff-data').set({
    value: JSON.stringify(staff),
    updatedAt: new Date().toISOString()
  });
}

function findPerson(staff, team, name) {
  if (!staff || !name) return null;
  const list = team === 'head' ? staff.heads : (staff[team] || []);
  return (list || []).find(p => p.name === name) || null;
}

// Sends a push to every device a person is logged in on, and quietly prunes
// any device token Firebase reports as dead (uninstalled, revoked, expired)
// so Manage Logins' "On/Off" status stays accurate over time.
async function sendPushToPerson(team, name, title, body, data) {
  const staff = await loadStaff();
  const person = findPerson(staff, team, name);
  if (!person || !Array.isArray(person.fcmTokens) || person.fcmTokens.length === 0) return;

  const tokens = person.fcmTokens;
  let resp;
  try {
    resp = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: data || {},
      webpush: { fcmOptions: { link: 'https://shbvleads.in/' } }
    });
  } catch (e) {
    logger.error(`Push send failed for ${team}/${name}`, e);
    return;
  }

  const deadTokens = [];
  resp.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token') {
        deadTokens.push(tokens[i]);
      }
    }
  });
  if (deadTokens.length) {
    person.fcmTokens = person.fcmTokens.filter(t => !deadTokens.includes(t));
    await saveStaff(staff);
    logger.log(`Pruned ${deadTokens.length} dead token(s) for ${team}/${name}`);
  }
}

// ---- 1. Instant push on a new referral ----
exports.onLeadWritten = onDocumentWritten('shbv_kv/{docId}', async (event) => {
  const docId = event.params.docId;
  if (!docId.startsWith(LEADS_V2_PREFIX)) return; // not a lead document (e.g. staff-data)

  const after = event.data.after.exists ? event.data.after.data() : null;
  if (!after) return; // lead was deleted

  const before = event.data.before.exists ? event.data.before.data() : null;
  const beforeAssignmentIds = new Set((before && before.assignments || []).map(a => a.id));
  const afterAssignments = after.assignments || [];

  for (const a of afterAssignments) {
    if (!beforeAssignmentIds.has(a.id) && a.salesperson) {
      await sendPushToPerson(
        a.team,
        a.salesperson,
        'SHBV Leads',
        `New lead referred to you: ${after.name}`,
        { leadId: after.id || '' }
      );
    }
  }
});

// ---- 2. Daily "due today" digest, 9:30am IST ----
exports.dailyFollowUpDigest = onSchedule(
  { schedule: '30 9 * * *', timeZone: 'Asia/Kolkata' },
  async () => {
    const snap = await db.collection('shbv_kv')
      .where(admin.firestore.FieldPath.documentId(), '>=', LEADS_V2_PREFIX)
      .where(admin.firestore.FieldPath.documentId(), '<', LEADS_V2_PREFIX + '')
      .get();
    if (snap.empty) return;

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
    const counts = new Map(); // "team|salesperson" -> count

    snap.docs.forEach(d => {
      const lead = d.data();
      (lead.assignments || []).forEach(a => {
        if (!a.salesperson || a.status === 'lost') return;
        const dueToday =
          (a.nextFollowUp && a.nextFollowUp.slice(0, 10) === todayStr) ||
          (a.meetingDate && a.meetingDate.slice(0, 10) === todayStr) ||
          (a.postSaleNextDate && a.postSaleNextDate.slice(0, 10) === todayStr);
        if (dueToday) {
          const key = `${a.team}|${a.salesperson}`;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      });
    });

    for (const [key, count] of counts) {
      const [team, name] = key.split('|');
      await sendPushToPerson(
        team,
        name,
        'SHBV Leads',
        `You have ${count} follow-up${count > 1 ? 's' : ''} due today.`,
        {}
      );
    }
  }
);
