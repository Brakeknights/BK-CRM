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

async function createOrFindSquareCustomer({ firstName, lastName, phone, email, vehicle, note }) {
  // Search by email first, then phone
  const filters = [];
  if (email) filters.push({ emailAddress: { exact: email } });
  if (phone) filters.push({ phoneNumber: { exact: phone } });

  for (const filter of filters) {
    const search = await client.customers.search({ query: { filter } });
    const existing = search.customers?.[0];
    if (existing) return { action: 'found', customerId: existing.id };
  }

  // Not found — create new customer
  const body = {
    givenName: firstName,
    familyName: lastName,
    referenceId: `bk-web-${Date.now()}`,
  };
  if (email) body.emailAddress = email;
  if (phone) body.phoneNumber = phone;
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
