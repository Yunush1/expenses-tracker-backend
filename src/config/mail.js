const nodemailer = require("nodemailer");
const config = require("./env");
const logger = require("../utils/logger");

/**
 * The SMTP transport, initialised once and **optionally**.
 *
 * Structurally identical to config/firebase.js and config/redis.js, and for the
 * same reason: sharing a sheet by email is an enhancement on top of sharing it by
 * link, so a deployment with no mail account should serve a working share dialog
 * that hands the user a link to send themselves — not a 500, and not a boot
 * failure. `MAIL_*` is therefore absent from `REQUIRED` in config/env.js.
 *
 * ## The rule every caller must honour
 *
 * **Nothing in this app is allowed to fail because an email failed.** A grant is
 * a row in the database; the message is a courtesy notification that the row
 * exists. If the relay is down, the invitation is still valid, the invitee can
 * still be sent the link by hand, and the sharer is told the message did not go
 * out. Wrapping the send in a transaction with the grant would mean a flaky SMTP
 * host silently removing people's ability to share at all.
 *
 * That is why `send()` resolves rather than throws, and why it returns *whether*
 * it sent. The caller reports that to the client; the client says "invitation
 * sent" or "couldn't email them — copy the link" accordingly.
 */

let transport = null;
/** Distinguishes "not configured" from "configured and initialised". */
let configured = false;

const initMail = () => {
  if (transport) return transport;

  const { host, port, user, pass, secure, from } = config.mail;

  if (!host) {
    logger.warn(
      "[mail] SMTP not configured — sheet invitations will not be emailed. " +
        "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM to enable them. " +
        "Sharing still works: the share dialog offers a link to send by hand."
    );
    return null;
  }

  if (!from) {
    // Worth its own line: a host with no From is a configuration half-done, and
    // most relays reject the message rather than guessing a sender.
    logger.warn(
      "[mail] SMTP_HOST is set but MAIL_FROM (and SMTP_USER) are empty — " +
        "most relays reject a message with no sender. Email stays disabled."
    );
    return null;
  }

  try {
    transport = nodemailer.createTransport({
      host,
      port,
      secure,
      // Omitted entirely when absent: passing `auth: { user: "", pass: "" }`
      // makes nodemailer attempt AUTH with empty credentials, which a relay that
      // wanted no authentication at all will reject.
      ...(user || pass ? { auth: { user, pass } } : {}),
      /**
       * A hung SMTP connection must not hold an HTTP request open. These are
       * short because the send is already fire-and-forget from the caller's
       * point of view — the grant is committed before the message is attempted.
       */
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      /**
       * One connection reused across invitations rather than a fresh handshake
       * per message. Sharing a sheet with eight people is one dialog and eight
       * sends, and eight TLS handshakes to the same host is waste.
       */
      pool: true,
      maxConnections: 3,
    });

    configured = true;
    logger.info(`[mail] SMTP enabled via ${host}:${port} (secure: ${secure}) as ${from}`);

    /**
     * Verified in the background, never awaited.
     *
     * Boot must not block on a third-party host, and a failure here is not fatal
     * — the transport stays and individual sends will surface their own errors.
     * The value is a clear line in the log at startup rather than a mystery when
     * the first invitation quietly fails hours later.
     */
    transport
      .verify()
      .then(() => logger.info("[mail] SMTP credentials verified"))
      .catch((err) =>
        logger.warn(
          `[mail] SMTP configured but the server did not accept the connection: ${err.message}. ` +
            "Invitations will still be created; the email may not arrive."
        )
      );

    return transport;
  } catch (err) {
    logger.error(`[mail] Failed to initialise — email disabled: ${err.message}`);
    transport = null;
    configured = false;
    return null;
  }
};

const isMailEnabled = () => Boolean(transport) && configured;

/**
 * Send one message. Resolves `true` if the relay accepted it, `false` otherwise
 * — and **never rejects**.
 *
 * The swallowed error is deliberate and is the whole contract of this module (see
 * the header). It is logged at `warn` with the recipient, because "did my
 * invitation go out?" is a question support will be asked and the log is the only
 * place that can answer it.
 */
const send = async ({ to, subject, html, text }) => {
  if (!isMailEnabled()) return false;

  try {
    await transport.sendMail({
      from: config.mail.from,
      ...(config.mail.replyTo ? { replyTo: config.mail.replyTo } : {}),
      to,
      subject,
      text,
      html,
    });
    logger.info(`[mail] Sent "${subject}" to ${to}`);
    return true;
  } catch (err) {
    logger.warn(`[mail] Could not send "${subject}" to ${to}: ${err.message}`);
    return false;
  }
};

module.exports = { initMail, isMailEnabled, send };
