import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { UserStore, UserError, hashPassword, verifyPassword } from '../users.mjs';
import { validateBusiness, normalizeBusinessInput } from '../config.mjs';
import { Calendar, datePlus } from '../calendar.mjs';
import { disposable, removeDisposable } from '../checks/helpers/fixtures.mjs';

test('password hashing uses scrypt with per-user salts and rejects wrong passwords', () => {
  const hashA = hashPassword('correct-horse-99');
  const hashB = hashPassword('correct-horse-99');
  assert(hashA.startsWith('scrypt$'));
  assert.notEqual(hashA, hashB);
  assert.equal(verifyPassword('correct-horse-99', hashA), true);
  assert.equal(verifyPassword('wrong-password', hashA), false);
  assert.throws(() => hashPassword('short'), (err) => err instanceof UserError && err.code === 'INVALID_ARGUMENTS');
});

test('UserStore enforces unique emails, hides passwordHash, isolates users and persists to disk', async () => {
  const dir = await disposable('users-store-');
  const file = path.join(dir, 'users.json');
  try {
    const store1 = new UserStore(file);
    const alice = store1.register({
      fullName: 'Alice Verma',
      email: 'Alice@Example.com',
      password: 'alice-password-1',
      business: {
        name: 'Verma Advisory',
        address: '14 MG Road, Bengaluru',
        contact: { name: 'Alice Verma', phone: '+91 98111 00001', email: 'desk@verma.example' }
      }
    });
    assert.equal(alice.email, 'alice@example.com');
    assert.equal(alice.profileCompleted, false);
    const pubAlice = store1.publicUser(alice);
    assert.equal(pubAlice.passwordHash, undefined);
    assert.equal(pubAlice.email, 'alice@example.com');

    assert.throws(
      () => store1.register({ fullName: 'Duplicate', email: 'alice@example.com', password: 'another-password' }),
      (err) => err instanceof UserError && err.code === 'CONFLICT' && err.status === 409
    );

    assert.throws(
      () => store1.authenticate('alice@example.com', 'wrong-pass'),
      (err) => err instanceof UserError && err.code === 'AUTH_DENIED' && err.status === 401
    );
    assert.equal(store1.authenticate('ALICE@example.com', 'alice-password-1').id, alice.id);

    const updatedAlice = store1.updateBusiness(alice.id, {
      name: 'Verma Advisory LLP',
      tagline: 'Personal tax and legal help',
      address: '14 MG Road, Bengaluru 560001',
      currency: 'INR',
      locale: 'en-IN',
      timezone: 'Asia/Kolkata',
      contact: { name: 'Alice Verma', phone: '+91 98111 00001', email: 'hello@verma.example' },
      services: [
        {
          name: 'Tax Consultation',
          minutes: 45,
          price: 1500,
          description: 'Annual filing review',
          contact: { name: 'Rohan Mehta', role: 'Senior CA', phone: '+91 98222 11111', email: 'rohan@verma.example' }
        },
        {
          name: 'Company Registration',
          minutes: 60,
          price: 4500,
          contact: { name: 'Priya Nair', role: 'Legal Lead', phone: '+91 98222 22222', email: 'priya@verma.example' }
        }
      ]
    });
    assert.equal(updatedAlice.profileCompleted, true);
    assert.equal(updatedAlice.business.services.length, 2);
    assert.equal(updatedAlice.business.services[0].id, 'tax-consultation');
    assert.equal(updatedAlice.business.services[0].contact.name, 'Rohan Mehta');

    const bob = store1.register({
      fullName: 'Bob Smith',
      email: 'bob@smith.example',
      password: 'bob-password-2',
      business: {
        name: 'Smith Design Co',
        address: '200 Market St, San Francisco',
        currency: 'USD',
        locale: 'en-US',
        timezone: 'America/Los_Angeles',
        services: [
          { name: 'Brand Sprint', minutes: 60, price: 250, contact: { name: 'Bob Smith', phone: '+1 415 555 0100' } }
        ]
      }
    });
    assert.equal(bob.profileCompleted, true);

    const calAlice = new Calendar(null, updatedAlice.business, () => Date.now(), updatedAlice.bookings);
    const tomorrow = datePlus(1, updatedAlice.business.timezone);
    const draft = calAlice.draft('tax-consultation', tomorrow, '09:00', 'Client One');
    assert.equal(draft.businessAddress, '14 MG Road, Bengaluru 560001');
    assert.equal(draft.contact.name, 'Rohan Mehta');
    assert.equal(draft.contact.phone, '+91 98222 11111');
    const booking = calAlice.confirm(draft);
    store1.addBooking(alice.id, booking);

    // Reload from disk to verify persistence and isolation.
    const store2 = new UserStore(file);
    const reloadedAlice = store2.getById(alice.id);
    const reloadedBob = store2.getById(bob.id);
    assert.equal(reloadedAlice.business.name, 'Verma Advisory LLP');
    assert.equal(reloadedAlice.business.services[1].contact.email, 'priya@verma.example');
    assert.equal(reloadedAlice.bookings.length, 1);
    assert.equal(reloadedBob.business.name, 'Smith Design Co');
    assert.equal(reloadedBob.bookings.length, 0);

    assert.equal(store2.removeBooking(alice.id, booking.id), true);
    assert.equal(store2.getById(alice.id).bookings.length, 0);
  } finally {
    await removeDisposable(dir);
  }
});

test('business contact validation rejects invalid contact emails and empty services', () => {
  const valid = normalizeBusinessInput({
    name: 'Test Co',
    address: '1 Main St',
    contact: { name: 'Owner', phone: '123456', email: 'owner@test.example' },
    services: [{ name: 'Session', minutes: 30, price: 100, contact: { name: 'Staff', email: 'staff@test.example' } }]
  });
  validateBusiness(valid);
  assert.throws(
    () => normalizeBusinessInput({
      name: 'Test Co',
      address: '1 Main St',
      contact: { email: 'not-an-email' },
      services: [{ name: 'Session', minutes: 30, price: 100 }]
    }),
    /valid contact email/i
  );
  assert.throws(
    () => normalizeBusinessInput({
      name: 'Test Co',
      address: '1 Main St',
      services: [{ name: 'Session', minutes: 30, price: 100, contact: { email: 'bad' } }]
    }),
    /valid contact email/i
  );
  assert.throws(
    () => normalizeBusinessInput({ name: 'Test Co', address: '1 Main St', services: [] }),
    /at least one service/i
  );
});

