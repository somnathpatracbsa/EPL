/**
 * Staleness Check — a safety net, not the primary sync mechanism.
 *
 * GitHub Actions' `schedule:` cron trigger is "best effort" and can silently go hours late,
 * especially on lower-activity repos — this is a known GitHub limitation, not a bug in this
 * project. The real fix is an external cron service (e.g. cron-job.org) calling this repo's
 * workflow_dispatch API every hour, which bypasses GitHub's internal scheduler entirely.
 *
 * This script is a backup: it checks how long it's been since the main sync last completed
 * successfully, and fails loudly (non-zero exit code) if it's been too long. A failed GitHub
 * Actions run triggers GitHub's automatic failure-notification email to the repo owner by
 * default — so this piggybacks on that for free, no extra alerting infrastructure needed.
 *
 * Honest caveat: this check is itself a scheduled GitHub Action, so it has the same
 * fundamental unreliability as what it's checking. It's a best-effort second layer, not a
 * guarantee — but a late alert is far better than no alert.
 */

import admin from 'firebase-admin';

const STALE_THRESHOLD_MINUTES = 150; // hourly sync + external cron + buffer for normal delay

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

async function main() {
  const snap = await db.collection('config').doc('current').get();
  if (!snap.exists || !snap.data().lastSyncAt) {
    console.error('No lastSyncAt found in config/current — the main sync may never have completed successfully.');
    process.exit(1);
  }

  const lastSyncAt = snap.data().lastSyncAt.toDate();
  const minutesSince = (Date.now() - lastSyncAt.getTime()) / (1000 * 60);

  console.log(`Last successful sync: ${lastSyncAt.toISOString()} (${Math.round(minutesSince)} minutes ago).`);

  if (minutesSince > STALE_THRESHOLD_MINUTES) {
    console.error(`STALE: sync hasn't run successfully in ${Math.round(minutesSince)} minutes (threshold: ${STALE_THRESHOLD_MINUTES}). Check the external cron pinger and the main sync workflow's recent runs.`);
    process.exit(1);
  }

  console.log('Sync is fresh — no action needed.');
}

main().catch(err => { console.error('Staleness check itself failed:', err); process.exit(1); });
