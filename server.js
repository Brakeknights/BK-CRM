const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use('/images', express.static(path.join(__dirname, 'public/images'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));
app.use('/css', express.static(path.join(__dirname, 'public/css'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/contact', async (req, res) => {
  const { firstName, lastName, phone, email, vehicle, message, source } = req.body;

  if (!firstName || !lastName || !phone) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  if (!process.env.SMTP_PASS) {
    console.error('SMTP_PASS environment variable is not set');
    return res.status(500).json({ success: false, error: 'Email not configured' });
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    auth: {
      user: 'greetings@brakeknights.com',
      pass: process.env.SMTP_PASS
    }
  });

  // Internal notification email to Brake Knights
  const internalHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #ddd;border-radius:8px;">
      <div style="background:#0a1f3d;padding:16px 20px;border-radius:6px 6px 0 0;margin:-20px -20px 20px;">
        <h2 style="color:#c9a84c;margin:0;font-size:1.3rem;"><img src="https://brakeknights.com/images/favicon.png" alt="" style="width:24px;height:24px;vertical-align:middle;margin-right:8px;border-radius:4px;"> New Service Request — Brake Knights</h2>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:0.95rem;">
        <tr><td style="padding:8px 12px;font-weight:bold;color:#0a1f3d;width:130px;">Name</td><td style="padding:8px 12px;">${firstName} ${lastName}</td></tr>
        <tr style="background:#f9f9f9;"><td style="padding:8px 12px;font-weight:bold;color:#0a1f3d;">Phone</td><td style="padding:8px 12px;"><a href="tel:${phone}">${phone}</a></td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:#0a1f3d;">Email</td><td style="padding:8px 12px;"><a href="mailto:${email}">${email || 'Not provided'}</a></td></tr>
        <tr style="background:#f9f9f9;"><td style="padding:8px 12px;font-weight:bold;color:#0a1f3d;">Vehicle</td><td style="padding:8px 12px;">${vehicle || 'Not provided'}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:#0a1f3d;">Message</td><td style="padding:8px 12px;">${message || 'None'}</td></tr>
        <tr style="background:#f9f9f9;"><td style="padding:8px 12px;font-weight:bold;color:#0a1f3d;">Source</td><td style="padding:8px 12px;">${source || 'Website'}</td></tr>
      </table>
      <div style="margin-top:20px;padding:12px;background:#fff8e1;border-left:4px solid #c9a84c;border-radius:4px;font-size:0.85rem;color:#555;">
        Reply directly to this email to respond to the customer.
      </div>
    </div>
  `;

  // Customer confirmation email
  const confirmationHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;">
      <!-- Header -->
      <div style="background:#0a1f3d;padding:28px 32px;border-radius:8px 8px 0 0;text-align:center;">
        <h1 style="color:#ffffff;margin:0 0 4px;font-size:1.5rem;letter-spacing:-0.5px;"><img src="https://brakeknights.com/images/favicon.png" alt="" style="width:32px;height:32px;vertical-align:middle;margin-right:10px;border-radius:6px;"> Brake Knights</h1>
        <p style="color:#8aadcf;margin:0;font-size:0.9rem;">Mobile Brake Service — Northern Virginia</p>
      </div>

      <!-- Body -->
      <div style="padding:32px;border:1px solid #e0e7ef;border-top:none;border-radius:0 0 8px 8px;">
        <h2 style="color:#0a1f3d;margin:0 0 12px;font-size:1.2rem;">Hi ${firstName}, we got your message!</h2>
        <p style="color:#444;line-height:1.6;margin:0 0 24px;">
          Thanks for reaching out to Brake Knights. We'll review your information and get back to you shortly to discuss your brake service and provide a quote.
        </p>

        <!-- Request summary -->
        <div style="background:#f4f7fb;border-radius:6px;padding:20px;margin-bottom:24px;">
          <p style="margin:0 0 12px;font-weight:bold;color:#0a1f3d;font-size:0.95rem;">What You Sent Us</p>
          <table style="width:100%;border-collapse:collapse;font-size:0.9rem;color:#444;">
            <tr><td style="padding:5px 0;color:#888;width:90px;">Name</td><td style="padding:5px 0;">${firstName} ${lastName}</td></tr>
            <tr><td style="padding:5px 0;color:#888;">Phone</td><td style="padding:5px 0;">${phone}</td></tr>
            ${vehicle ? `<tr><td style="padding:5px 0;color:#888;">Vehicle</td><td style="padding:5px 0;">${vehicle}</td></tr>` : ''}
            ${message ? `<tr><td style="padding:5px 0;color:#888;vertical-align:top;">Notes</td><td style="padding:5px 0;">${message}</td></tr>` : ''}
          </table>
        </div>

        <!-- What to expect -->
        <p style="color:#0a1f3d;font-weight:bold;margin:0 0 10px;font-size:0.95rem;">What happens next?</p>
        <ol style="color:#444;line-height:1.8;margin:0 0 24px;padding-left:20px;font-size:0.9rem;">
          <li>We'll review your message and reach out by phone, text, or email to discuss your service and provide a quote.</li>
          <li>Once you're happy with the quote, we'll schedule a time and location that works for you.</li>
          <li>Our knight comes to you — fully equipped, no shop visit needed.</li>
        </ol>

        <!-- Contact -->
        <div style="border-top:1px solid #e0e7ef;padding-top:20px;text-align:center;">
          <p style="color:#888;font-size:0.85rem;margin:0 0 8px;">Questions? Reach us directly:</p>
          <a href="tel:7039774475" style="color:#0a1f3d;font-weight:bold;font-size:1rem;text-decoration:none;">📞 703-977-4475</a>
          <span style="color:#ccc;margin:0 10px;">|</span>
          <a href="mailto:greetings@brakeknights.com" style="color:#0a1f3d;font-size:0.9rem;text-decoration:none;">greetings@brakeknights.com</a>
        </div>
      </div>

      <!-- Footer -->
      <div style="text-align:center;padding:16px;color:#aaa;font-size:0.78rem;">
        Brake Knights · Sterling, VA · brakeknights.com
      </div>
    </div>
  `;

  try {
    // Send internal notification
    await transporter.sendMail({
      from: '"Brake Knights Website" <greetings@brakeknights.com>',
      to: 'greetings@brakeknights.com',
      replyTo: email || 'greetings@brakeknights.com',
      subject: `New Service Request: ${firstName} ${lastName}`,
      html: internalHtml
    });

    // Send customer confirmation if they provided an email
    if (email) {
      await transporter.sendMail({
        from: '"Brake Knights" <greetings@brakeknights.com>',
        to: email,
        subject: `We received your request, ${firstName}! — Brake Knights`,
        html: confirmationHtml
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Email send error:', err.code, err.message);
    res.status(500).json({ success: false, error: 'Failed to send email' });
  }
});

app.listen(PORT, () => {
  console.log(`Brakeknights server running on port ${PORT}`);
});
