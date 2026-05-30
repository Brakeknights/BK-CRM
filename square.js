const { SquareClient, SquareEnvironment } = require('square');

const useSandbox = !process.env.SQUARE_ACCESS_TOKEN || process.env.SQUARE_ENV === 'sandbox';

const client = new SquareClient({
  token: useSandbox
    ? process.env.SQUARE_SANDBOX_ACCESS_TOKEN
    : process.env.SQUARE_ACCESS_TOKEN,
  environment: useSandbox ? SquareEnvironment.Sandbox : SquareEnvironment.Production,
});

async function verifyConnection() {
  const results = {};

  try {
    await client.locations.list();
    results.customers = 'ok';
  } catch (err) {
    results.customers = err.message || 'error';
  }

  try {
    await client.bookings.getBusinessProfile();
    results.bookings = 'ok';
  } catch (err) {
    results.bookings = err.message || 'error';
  }

  return { environment: useSandbox ? 'sandbox' : 'production', ...results };
}

function toE164(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return null;
}

async function createOrFindSquareCustomer({ firstName, lastName, phone, email, vehicle, note }) {
  const e164Phone = phone ? toE164(phone) : null;

  // Search by email first, then phone — each in its own try/catch so one failure doesn't abort
  if (email) {
    try {
      const search = await client.customers.search({ query: { filter: { emailAddress: { exact: email } } } });
      const existing = search.customers?.[0];
      if (existing) return { action: 'found', customerId: existing.id };
    } catch (_) {}
  }

  if (e164Phone) {
    try {
      const search = await client.customers.search({ query: { filter: { phoneNumber: { exact: e164Phone } } } });
      const existing = search.customers?.[0];
      if (existing) return { action: 'found', customerId: existing.id };
    } catch (_) {}
  }

  // Not found — create new customer
  const body = {
    givenName: firstName,
    familyName: lastName,
    referenceId: `bk-web-${Date.now()}`,
  };
  if (email) body.emailAddress = email;
  if (e164Phone) body.phoneNumber = e164Phone;
  if (vehicle || note) {
    const parts = [];
    if (vehicle) parts.push(`Vehicle: ${vehicle}`);
    if (note) parts.push(note);
    body.note = parts.join('\n');
  }

  const result = await client.customers.create(body);
  return { action: 'created', customerId: result.customer?.id };
}

module.exports = { client, verifyConnection, createOrFindSquareCustomer };
