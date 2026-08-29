const { initializeApp, getApp, getApps, cert } = require("firebase-admin/app");
// Aliased: this module exports its own `getMessaging` / `getAuth` — the cached
// instances rather than the SDK factories — and identical names would read as one.
const { getMessaging: buildMessaging } = require("firebase-admin/messaging");
const { getAuth: buildAuth } = require("firebase-admin/auth");
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
let auth = null;

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

/**
 * Why a key cannot be used, in words that point at the .env file.
 *
 * The SDK's own message for every one of these is "Failed to parse private key",
 * which sends people to look at the code — as the note on `normalizePrivateKey`
 * says, it "says nothing about a stray comma". These checks run first so the log
 * names the actual problem.
 *
 * Returns null when the key looks well-formed. It is a shape check, not a
 * validation: whether the key is *correct* is the SDK's business, and a wrong but
 * well-formed key still gets its own error below.
 */
const describeKeyProblem = (key) => {
  if (!key.includes("-----BEGIN")) {
    return "it does not start with -----BEGIN PRIVATE KEY-----";
  }
  if (!key.includes("-----END")) {
    return (
      `it is truncated — no -----END PRIVATE KEY----- marker, and only ${key.length} ` +
      "characters (a real key is around 1,700). The usual cause is an unbalanced " +
      "quote in .env: the value must be one line wrapped in double quotes, with " +
      String.raw`\n` +
      " standing in for each newline"
    );
  }
  if (key.includes('"') || key.includes("'")) {
    return "it still contains a quote character, so the surrounding quotes were not stripped";
  }
  if (!key.includes("\n")) {
    return `it has no line breaks — the ${String.raw`\n`} escapes were lost before this point`;
  }
  return null;
};

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

  const key = normalizePrivateKey(privateKey);
  const problem = describeKeyProblem(key);

  if (problem) {
    logger.error(
      `[firebase] FIREBASE_PRIVATE_KEY is unusable — push and auth disabled: ${problem}.`
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
            privateKey: key,
          }),
        });

    messaging = buildMessaging(app);
    // One Admin app serves both. Auth verifies ID tokens for the personal ledger
    // (docs/09-AUTH.md); the group API never touches it.
    auth = buildAuth(app);
    logger.info(`[firebase] Push and auth enabled for project ${projectId}`);
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

/**
 * The Auth instance, or null when Firebase is unconfigured.
 *
 * Null is what makes the scoping in docs/09-AUTH.md §1 structural rather than
 * merely intended: with no credentials, ledger routes fail closed while the whole
 * group API carries on. A deployment can run this app with no Firebase at all and
 * lose nothing but the ledger.
 */
const getAuth = () => auth;

const isAuthEnabled = () => Boolean(auth);

module.exports = { initFirebase, getMessaging, isPushEnabled, getAuth, isAuthEnabled };
