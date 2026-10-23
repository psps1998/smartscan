// Outgoing email (activation, password reset). Uses SMTP (AWS SES in production, see .env.example).
// With SMTP_HOST unset nothing is sent: the message, including its link, is written to the log, so the flows can be tested locally.
import nodemailer from 'nodemailer';

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
const port = Number(SMTP_PORT) || 587;
const transport = SMTP_HOST
  ? nodemailer.createTransport({ host: SMTP_HOST, port, secure: port === 465, auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined })
  : null;

export const mailConfigured = !!transport;

export async function sendMail({ to, subject, text, html, replyTo }) {
  if (!transport) { console.log(`[mail not configured, not sent] To: ${to}\nSubject: ${subject}\n${text}`); return; }
  await transport.sendMail({ from: MAIL_FROM || 'Smartscan <no-reply@smartscan.in>', to, subject, text, html, replyTo });
}
