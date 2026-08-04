const { initializeApp, getApp, getApps, cert } = require("firebase-admin/app");
// Aliased: this module exports its own `getMessaging` — the cached instance
// rather than the SDK factory — and two identical names would read as one.
const { getMessaging: buildMessaging } = require("firebase-admin/messaging");
const config = require("./env");
const logger = require("../utils/logger");

/**
 * Firebase Admin, initialised once and **optionally**.
 *
 * ## Modular imports, not the `admin.*` namespace
 *
 * firebase-admin v13 removed the old namespaced API: on v14 `admin.apps` and
 * `admin.credential` are both `undefined`, so the familiar
 * `admin.apps.length ? … : admin.initializeApp({ credential: admin.credential.cert(…) })`
 * throws "Cannot read properties of undefined (reading 'length')" — a runtime
 * error that reads like a config problem and is not one. Every tutorial still
 * shows the old form; the subpath imports above are the current API.
 *
 * ## Optional on purpose
 *
 * Unlike MONGO_URI — which the config validator refuses to boot without, because
 * an API with no database can do nothing — push is an enhancement. A developer
 * running the stack locally, or a deployment that has not set up Firebase yet,
 * should get a working expense tracker that simply does not send notifications,
 * not a server that exits on startup. So the credentials are read here rather
 * than in the REQUIRED list, and their absence is a warning.
 *
 * Private-key normalisation is handled below — see `normalizePrivateKey` for the
 * paste hazards it exists to absorb.
 */

let messaging = null;

/**
 * Make a pasted service-account key parseable.
 *
 * The key is almost always copied out of the JSON file Google hands you, and that
 * file's line ends with a comma. Kept, that comma stops dotenv seeing a quoted
 * value at all — so the surrounding quotes are left *inside* the string and the
 * PEM parser is handed `"-----BEGIN PRIVATE KEY-----…` instead of
 * `-----BEGIN PRIVATE KEY-----…`. It fails with "Failed to parse private key",
 * which says nothing about a stray comma.
 *
 * Three cheap, order-dependent repairs, none of which can corrupt a well-formed
 * key (base64 contains no quotes, commas or backslashes):
 *
 *   1. trailing comma  — the JSON paste
 *   2. surrounding quotes — left behind by (1), or by a shell that ate them
 *   3. escaped newlines — a .env file cannot hold a literal multi-line value, so
 *      the newlines arrive as `\n`. dotenv expands these itself for a *correctly*
 *      quoted value, which makes this step a no-op in the happy path and the
 *      actual fix in every other one.
 */
const normalizePrivateKey = (raw) =>
  (raw || "")
    .trim()
    .replace(/,$/, "")
    .replace(/^(['"])([\s\S]*)\1$/, "$2")
    .replace(/\\n/g, "\n")
    .trim();

const initFirebase = () => {
  if (messaging) return messaging;

  const { projectId, clientEmail, privateKey } = config.firebase;

  if (!projectId || !clientEmail || !privateKey) {
    logger.warn(
      "[firebase] Service account not configured — push notifications are disabled. " +
        "Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY to enable them."
    );
    return null;
  }

  try {
    const app = getApps().length
      ? getApp()
      : initializeApp({
          credential: cert({
            projectId,
            clientEmail,
            privateKey: normalizePrivateKey(privateKey),
          }),
        });

    messaging = buildMessaging(app);
    logger.info(`[firebase] Push notifications enabled for project ${projectId}`);
    return messaging;
  } catch (err) {
    // A malformed key must not take the API down with it.
    logger.error(`[firebase] Failed to initialise — push disabled: ${err.message}`);
    return null;
  }
};

/** The cached instance — null when push is not configured. Every caller handles that. */
const getMessaging = () => messaging;

const isPushEnabled = () => Boolean(messaging);

module.exports = { initFirebase, getMessaging, isPushEnabled };
