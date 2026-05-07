// services/emailService.js
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === "true",

  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendPasswordResetEmail(to, resetUrl) {
  await transporter.sendMail({
    from: process.env.SMTP_FROM || '"Vyas Room Booking" <nir.test09@gmail.com>',
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

export async function sendWelcomeEmail(to, fullName) {
  const dashboardUrl = process.env.FRONTEND_ORIGIN;

  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || '"Vyas Room Booking" <nir.test09@gmail.com>',

    to,

    subject: "Welcome to Vyas Room Booking",

    text: [
      `Hi ${fullName},`,
      "",
      "Welcome to Vyas Room Booking.",
      "",
      "Your account has been created successfully.",
      "",
      `Access your dashboard here: ${dashboardUrl}`,
      "",
      "Thank you for joining us.",
    ].join("\n"),

    html: `
      <div style="margin:0;padding:0;background-color:#f4f7fb;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f7fb;padding:40px 0;">
          <tr>
            <td align="center">

              <table width="600" cellpadding="0" cellspacing="0" border="0"
                style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,0.08);">

                <!-- Header -->
                <tr>
                  <td align="center"
                    style="background:linear-gradient(135deg,#1e3a8a,#312e81);padding:40px 30px;">

                    <h1 style="margin:0;color:#ffffff;font-size:30px;font-weight:bold;">
                      Welcome to Vyas
                    </h1>

                    <p style="margin:12px 0 0;color:#dbeafe;font-size:16px;">
                      Smart Room Booking Platform
                    </p>
                  </td>
                </tr>

                <!-- Body -->
                <tr>
                  <td style="padding:40px 35px;">

                    <h2 style="margin:0 0 18px;color:#111827;font-size:24px;">
                      Hi ${fullName},
                    </h2>

                    <p style="margin:0 0 18px;color:#4b5563;font-size:16px;line-height:1.7;">
                      Your account has been created successfully using your MIT-WPU email.
                    </p>

                    <p style="margin:0 0 28px;color:#4b5563;font-size:16px;line-height:1.7;">
                      You can now book rooms, manage reservations, and access the Vyas Room Booking system securely.
                    </p>

                    <!-- Feature Box -->
                    <table width="100%" cellpadding="0" cellspacing="0" border="0"
                      style="background:#f9fafb;border-radius:12px;padding:20px;margin-bottom:30px;">

                      <tr>
                        <td style="padding:8px 0;color:#111827;font-size:15px;">
                          ✓ Easy room reservations
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:8px 0;color:#111827;font-size:15px;">
                          ✓ Secure MIT-WPU authentication
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:8px 0;color:#111827;font-size:15px;">
                          ✓ Manage upcoming bookings
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:8px 0;color:#111827;font-size:15px;">
                          ✓ Fast and responsive booking experience
                        </td>
                      </tr>

                    </table>

                    <!-- Button -->
                    <table cellpadding="0" cellspacing="0" border="0" align="center">
                      <tr>
                        <td align="center" bgcolor="#1e3a8a"
                          style="border-radius:10px;">

                          <a href="${dashboardUrl}"
                            style="display:inline-block;padding:14px 28px;color:#ffffff;
                            text-decoration:none;font-size:16px;font-weight:bold;">
                            Go to Dashboard
                          </a>

                        </td>
                      </tr>
                    </table>

                  </td>
                </tr>

                <!-- Footer -->
                <tr>
                  <td align="center"
                    style="padding:24px;background:#f9fafb;border-top:1px solid #e5e7eb;">

                    <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">
                      This email was sent to ${to}
                    </p>

                    <p style="margin:8px 0 0;color:#9ca3af;font-size:12px;">
                      © ${new Date().getFullYear()} Vyas Room Booking. All rights reserved.
                    </p>

                  </td>
                </tr>

              </table>

            </td>
          </tr>
        </table>
      </div>
    `,
  });

  console.log(`✅ Welcome email sent to ${to}`);
  console.log("📨 Message ID:", info.messageId);
}

export async function sendBookingConfirmationEmail({
  to,
  fullName,
  roomName,
  title,
  description,
  startTime,
  endTime,
  classDivision,
  panel,
  yearCourse,
}) {
  const dashboardUrl = process.env.FRONTEND_ORIGIN;

  const formattedStart = new Date(startTime).toLocaleString();
  const formattedEnd = new Date(endTime).toLocaleString();

  const info = await transporter.sendMail({
    from:
      process.env.SMTP_FROM || '"Vyas Room Booking" <noreply@mitwpu.edu.in>',

    to,

    subject: "Booking Confirmed — Vyas Room Booking",

    text: [
      `Hi ${fullName},`,
      "",
      "Your room booking has been confirmed.",
      "",
      `Room: ${roomName}`,
      `Title: ${title}`,
      `Start: ${formattedStart}`,
      `End: ${formattedEnd}`,
      "",
      "Thank you for using Vyas Room Booking.",
    ].join("\n"),

    html: `
      <div style="margin:0;padding:0;background-color:#f4f7fb;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"
          style="background-color:#f4f7fb;padding:40px 0;">

          <tr>
            <td align="center">

              <table width="600" cellpadding="0" cellspacing="0" border="0"
                style="background:#ffffff;border-radius:16px;
                overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,0.08);">

                <!-- Header -->
                <tr>
                  <td align="center"
                    style="background:linear-gradient(135deg,#1e3a8a,#312e81);
                    padding:40px 30px;">

                    <h1 style="margin:0;color:#ffffff;
                      font-size:28px;font-weight:bold;">

                      Booking Confirmed
                    </h1>

                    <p style="margin:12px 0 0;color:#dbeafe;font-size:16px;">
                      Your room has been reserved successfully
                    </p>

                  </td>
                </tr>

                <!-- Body -->
                <tr>
                  <td style="padding:40px 35px;">

                    <h2 style="margin:0 0 18px;color:#111827;font-size:24px;">
                      Hi ${fullName},
                    </h2>

                    <p style="margin:0 0 25px;color:#4b5563;
                      font-size:16px;line-height:1.7;">

                      Your booking has been successfully created in the
                      Vyas Room Booking system.
                    </p>

                    <!-- Booking Details -->
                    <table width="100%" cellpadding="0" cellspacing="0"
                      border="0"
                      style="background:#f9fafb;border-radius:12px;
                      padding:22px;margin-bottom:30px;">

                      <tr>
                        <td style="padding:10px 0;color:#111827;">
                          <strong>Room:</strong> ${roomName}
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:10px 0;color:#111827;">
                          <strong>Title:</strong> ${title}
                        </td>
                      </tr>

                      ${
                        description
                          ? `
                        <tr>
                          <td style="padding:10px 0;color:#111827;">
                            <strong>Description:</strong> ${description}
                          </td>
                        </tr>
                      `
                          : ""
                      }

                      <tr>
                        <td style="padding:10px 0;color:#111827;">
                          <strong>Start Time:</strong> ${formattedStart}
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:10px 0;color:#111827;">
                          <strong>End Time:</strong> ${formattedEnd}
                        </td>
                      </tr>

                      ${
                        classDivision
                          ? `
                        <tr>
                          <td style="padding:10px 0;color:#111827;">
                            <strong>Class Division:</strong> ${classDivision}
                          </td>
                        </tr>
                      `
                          : ""
                      }

                      ${
                        panel
                          ? `
                        <tr>
                          <td style="padding:10px 0;color:#111827;">
                            <strong>Panel:</strong> ${panel}
                          </td>
                        </tr>
                      `
                          : ""
                      }

                      ${
                        yearCourse
                          ? `
                        <tr>
                          <td style="padding:10px 0;color:#111827;">
                            <strong>Year/Course:</strong> ${yearCourse}
                          </td>
                        </tr>
                      `
                          : ""
                      }

                    </table>

                    <!-- Button -->
                    <table cellpadding="0" cellspacing="0" border="0"
                      align="center">

                      <tr>
                        <td align="center" bgcolor="#1e3a8a"
                          style="border-radius:10px;">

                          <a href="${dashboardUrl}"
                            style="display:inline-block;
                            padding:14px 28px;
                            color:#ffffff;
                            text-decoration:none;
                            font-size:16px;
                            font-weight:bold;">

                            View Dashboard
                          </a>

                        </td>
                      </tr>

                    </table>

                  </td>
                </tr>

                <!-- Footer -->
                <tr>
                  <td align="center"
                    style="padding:24px;background:#f9fafb;
                    border-top:1px solid #e5e7eb;">

                    <p style="margin:0;color:#6b7280;
                      font-size:13px;line-height:1.6;">

                      This booking confirmation was sent to ${to}
                    </p>

                    <p style="margin:8px 0 0;color:#9ca3af;font-size:12px;">
                      © ${new Date().getFullYear()} Vyas Room Booking
                    </p>

                  </td>
                </tr>

              </table>

            </td>
          </tr>

        </table>
      </div>
    `,
  });

  console.log(`✅ Booking confirmation email sent to ${to}`);
  console.log("📨 Message ID:", info.messageId);
}
