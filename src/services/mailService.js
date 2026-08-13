const config = require("../config/env");
const { send, isMailEnabled } = require("../config/mail");

/**
 * The messages this app sends, and the markup they are made of
 * (docs/20-EXPENSE-SHEETS.md §5).
 *
 * ## Every function here returns a boolean and never throws
 *
 * Inherited from config/mail.js and restated because it is the contract callers
 * depend on: sharing a sheet must not fail because a mail server did. The caller
 * commits the grant, then asks whether the notification went out, and tells the
 * client either "invitation sent" or "couldn't email them — here's the link".
 *
 * ## Why the HTML is this plain
 *
 * No external CSS, no web fonts, no images, no layout tables beyond one centred
 * container. Mail clients strip stylesheets, block remote images by default, and
 * Outlook renders with Word's engine — so anything more elaborate degrades into
 * something worse than plain. Inline styles on a single column survive
 * everywhere, including the text-only clients that get the `text` alternative.
 *
 * Both parts are always supplied. A message with no plaintext alternative scores
 * badly with spam filters, which for transactional mail nobody has opted into is
 * the difference between the inbox and the junk folder.
 */

const BRAND = "#4f46e5";
const INK = "#0f172a";
const MUTED = "#64748b";

/**
 * Any value interpolated into the HTML goes through this first.
 *
 * All of it is user-supplied — a sheet's title, an inviter's display name, the
 * message typed into a request — and it lands in a document rendered by someone
 * else's mail client. Escaping is what stops a sheet titled
 * `<img src=x onerror=...>` from becoming markup in a stranger's inbox.
 */
const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** The web app's URL for a sheet. `APP_BASE_URL` is already stripped of trailing slashes. */
const sheetUrl = (shareCode) => `${config.appBaseUrl}/sheet/${shareCode}`;

const button = (href, label) => `
  <a href="${escapeHtml(href)}"
     style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;
            padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;">
    ${escapeHtml(label)}
  </a>`;

/**
 * The shell every message shares.
 *
 * `body` is pre-built HTML from the senders below and is **not** escaped here —
 * each of them escapes its own interpolations at the point of use, because that
 * is where it is visible whether a value came from a user or from us.
 */
const layout = ({ heading, body, footer }) => `
<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f8fafc;
               font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;
                padding:32px;border:1px solid #e2e8f0;">
      <p style="margin:0 0 24px;font-size:18px;font-weight:700;color:${BRAND};">
        ${escapeHtml(config.mail.appName)}
      </p>
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.4;color:${INK};font-weight:700;">
        ${heading}
      </h1>
      ${body}
      <p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:${MUTED};
                border-top:1px solid #e2e8f0;padding-top:16px;">
        ${footer}
      </p>
    </div>
  </body>
</html>`;

const roleWord = (role) => (role === "EDITOR" ? "edit" : "view");

/**
 * "Riya shared 'Q3 expenses' with you."
 *
 * The address is stated in the body on purpose. Access is bound to it
 * (models/sheetGrant.js), so someone reading this in a forwarded mail, or in a
 * shared inbox they sign into under a different account, needs to know *which*
 * address to use before they click and are told they lack access.
 */
const sendSheetInvite = async ({ to, sheetTitle, shareCode, inviterName, role, message }) => {
  if (!isMailEnabled()) return false;

  const url = sheetUrl(shareCode);
  const inviter = inviterName || "Someone";
  const verb = roleWord(role);

  const body = `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${INK};">
      <strong>${escapeHtml(inviter)}</strong> shared the expense sheet
      <strong>${escapeHtml(sheetTitle)}</strong> with you, and you can ${verb} it.
    </p>
    ${
      message
        ? `<p style="margin:0 0 20px;padding:12px 16px;background:#f8fafc;border-left:3px solid ${BRAND};
                     font-size:14px;line-height:1.6;color:${INK};">${escapeHtml(message)}</p>`
        : ""
    }
    <p style="margin:0 0 24px;">${button(url, "Open the sheet")}</p>
    <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED};">
      Sign in as <strong>${escapeHtml(to)}</strong> — this sheet was shared with that
      address, so another account will not be able to open it.
    </p>`;

  return send({
    to,
    subject: `${inviter} shared "${sheetTitle}" with you`,
    html: layout({
      heading: `${escapeHtml(inviter)} shared an expense sheet with you`,
      body,
      footer:
        `You are receiving this because ${escapeHtml(inviter)} entered this address in ` +
        `${escapeHtml(config.mail.appName)}. If you were not expecting it, you can ignore this message — ` +
        `nothing is shared back, and no account was created for you.`,
    }),
    text: [
      `${inviter} shared the expense sheet "${sheetTitle}" with you, and you can ${verb} it.`,
      message ? `\n"${message}"\n` : "",
      `Open it: ${url}`,
      "",
      `Sign in as ${to} — this sheet was shared with that address, so another account will not be able to open it.`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
};

/**
 * "Priya is asking for access to your sheet."
 *
 * Deliberately has no approve-from-email link. A one-click grant in an email is
 * bearer authority over a permission change — forwarded or leaked, it hands
 * someone else the ability to admit a stranger to company spending. The owner
 * opens the sheet and decides there, signed in.
 */
const sendAccessRequest = async ({ to, sheetTitle, shareCode, requesterName, requesterEmail, message, role }) => {
  if (!isMailEnabled()) return false;

  const url = `${sheetUrl(shareCode)}?share=requests`;
  const who = requesterName ? `${requesterName} (${requesterEmail})` : requesterEmail;

  const body = `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${INK};">
      <strong>${escapeHtml(who)}</strong> is asking for
      ${escapeHtml(roleWord(role))} access to <strong>${escapeHtml(sheetTitle)}</strong>.
    </p>
    ${
      message
        ? `<p style="margin:0 0 20px;padding:12px 16px;background:#f8fafc;border-left:3px solid ${BRAND};
                     font-size:14px;line-height:1.6;color:${INK};">${escapeHtml(message)}</p>`
        : ""
    }
    <p style="margin:0 0 24px;">${button(url, "Review the request")}</p>
    <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED};">
      Nobody gains access until you approve it. Ignoring this leaves the sheet exactly as it is.
    </p>`;

  return send({
    to,
    subject: `${requesterName || requesterEmail} is requesting access to "${sheetTitle}"`,
    html: layout({
      heading: "Someone is requesting access",
      body,
      footer:
        `You are receiving this because you own this sheet in ${escapeHtml(config.mail.appName)}. ` +
        `Requests expire on their own if nobody answers them.`,
    }),
    text: [
      `${who} is asking for ${roleWord(role)} access to "${sheetTitle}".`,
      message ? `\n"${message}"\n` : "",
      `Review it: ${url}`,
      "",
      "Nobody gains access until you approve it.",
    ]
      .filter(Boolean)
      .join("\n"),
  });
};

/** "You're in." The other half of the request loop — silence would be a bug. */
const sendAccessApproved = async ({ to, sheetTitle, shareCode, role, ownerName }) => {
  if (!isMailEnabled()) return false;

  const url = sheetUrl(shareCode);

  const body = `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${INK};">
      ${escapeHtml(ownerName || "The owner")} gave you ${escapeHtml(roleWord(role))} access to
      <strong>${escapeHtml(sheetTitle)}</strong>.
    </p>
    <p style="margin:0 0 24px;">${button(url, "Open the sheet")}</p>
    <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED};">
      Sign in as <strong>${escapeHtml(to)}</strong> — access is tied to that address.
    </p>`;

  return send({
    to,
    subject: `You now have access to "${sheetTitle}"`,
    html: layout({ heading: "Your access request was approved", body, footer: `Sent by ${escapeHtml(config.mail.appName)}.` }),
    text: [
      `${ownerName || "The owner"} gave you ${roleWord(role)} access to "${sheetTitle}".`,
      `Open it: ${url}`,
      "",
      `Sign in as ${to} — access is tied to that address.`,
    ].join("\n"),
  });
};

/**
 * "Your request was declined."
 *
 * Sent, rather than left as silence, because the alternative is someone waiting
 * indefinitely and then asking again — which is worse for both people. It carries
 * no reason and no link: a decline is the owner's decision and does not owe an
 * explanation to a stranger.
 */
const sendAccessDeclined = async ({ to, sheetTitle }) => {
  if (!isMailEnabled()) return false;

  return send({
    to,
    subject: `Your access request for "${sheetTitle}" was declined`,
    html: layout({
      heading: "Your access request was declined",
      body: `
        <p style="margin:0;font-size:15px;line-height:1.6;color:${INK};">
          The owner of <strong>${escapeHtml(sheetTitle)}</strong> declined your request for access.
          If you think this is a mistake, the best next step is to contact them directly.
        </p>`,
      footer: `Sent by ${escapeHtml(config.mail.appName)}.`,
    }),
    text:
      `The owner of "${sheetTitle}" declined your request for access. ` +
      `If you think this is a mistake, contact them directly.`,
  });
};

module.exports = {
  sendSheetInvite,
  sendAccessRequest,
  sendAccessApproved,
  sendAccessDeclined,
  isMailEnabled,
};
