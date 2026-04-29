// services/emailService.js
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendPasswordResetEmail(to, resetUrl) {
  await transporter.sendMail({
    from: process.env.SMTP_FROM || '"Vyas Room Booking" <noreply@mitwpu.edu.in>',
    to,
    subject: "Vyas — Password Reset",
    text: [
      "You requested a password reset for your Vyas Room Booking account.",
      "",
      `Reset link (valid for 1 hour): ${resetUrl}`,
      "",
      "If you did not request this, you can safely ignore this email.",
    ].join("\n"),
    html: `
      <p>You requested a password reset for your <strong>Vyas Room Booking</strong> account.</p>
      <p><a href="${resetUrl}">Click here to reset your password</a> (valid for 1 hour)</p>
      <p style="color:#888;font-size:12px;">If you did not request this, ignore this email.</p>
    `,
  });
}
