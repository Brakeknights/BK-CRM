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

module.exports = { client, verifyConnection };
