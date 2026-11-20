import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { business as defaultAppBusiness, normalizeBusinessInput } from './config.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class UserError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new UserError('INVALID_ARGUMENTS', 'Password must be between 8 and 128 characters.', 400);
  }
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !password || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hexHash] = parts;
  if (!salt || !hexHash) return false;
  try {
    const expected = Buffer.from(hexHash, 'hex');
    const actual = scryptSync(password, salt, 64);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export class UserStore {
  constructor(file, { defaultBusiness = defaultAppBusiness } = {}) {
    this.file = file || null;
    this.defaultBusiness = defaultBusiness;
    this.users = new Map();
    this.byEmail = new Map();
    this.#load();
  }

  #load() {
    if (!this.file || !existsSync(this.file)) return;
    const raw = JSON.parse(readFileSync(this.file, 'utf8'));
    const list = Array.isArray(raw?.users) ? raw.users : [];
    for (const user of list) {
      if (!user?.id || !user?.email) continue;
      this.users.set(user.id, user);
      this.byEmail.set(user.email.toLowerCase(), user);
    }
  }

  #save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ users: [...this.users.values()] }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  publicUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      profileCompleted: Boolean(user.profileCompleted),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };
  }

  #starterBusiness(fullName, email, rawBusiness) {
    const base = {
      name: `${fullName}'s Company`,
      tagline: 'Personal services & appointments',
      address: 'Add your company address',
      timezone: this.defaultBusiness.timezone,
      locale: this.defaultBusiness.locale,
      currency: this.defaultBusiness.currency,
      contact: { name: fullName, email },
      calendar: structuredClone(this.defaultBusiness.calendar),
      services: [
        {
          id: 'consultation',
          name: 'General consultation',
          minutes: 60,
          price: 500,
          description: 'Update this service with your own offerings and prices.',
          contact: { name: fullName, email }
        }
      ]
    };
    if (!rawBusiness || typeof rawBusiness !== 'object' || Array.isArray(rawBusiness)) {
      return { business: base, profileCompleted: false };
    }
    const hasCustomServices = Array.isArray(rawBusiness.services) && rawBusiness.services.length > 0;
    const candidate = {
      ...base,
      ...rawBusiness,
      tagline: typeof rawBusiness.tagline === 'string' && rawBusiness.tagline.trim() ? rawBusiness.tagline.trim() : base.tagline,
      contact: rawBusiness.contact || base.contact,
      services: hasCustomServices ? rawBusiness.services : base.services
    };
    try {
      const normalized = normalizeBusinessInput(candidate, base);
      return { business: normalized, profileCompleted: hasCustomServices };
    } catch (error) {
      throw new UserError('INVALID_ARGUMENTS', error.message, 400);
    }
  }

  register(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new UserError('INVALID_ARGUMENTS', 'Registration details are required.', 400);
    }
    const fullName = typeof payload.fullName === 'string' ? payload.fullName.trim() : '';
    if (!fullName || fullName.length > 100) {
      throw new UserError('INVALID_ARGUMENTS', 'Please enter your name (up to 100 characters).', 400);
    }
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!email || email.length > 160 || !EMAIL_RE.test(email)) {
      throw new UserError('INVALID_ARGUMENTS', 'Please enter a valid email address.', 400);
    }
    if (this.byEmail.has(email)) {
      throw new UserError('CONFLICT', 'An account with that email already exists.', 409);
    }
    const passwordHash = hashPassword(payload.password);
    const { business, profileCompleted } = this.#starterBusiness(fullName, email, payload.business);
    const nowIso = new Date().toISOString();
    const user = {
      id: randomUUID(),
      fullName,
      email,
      passwordHash,
      profileCompleted,
      business,
      bookings: [],
      createdAt: nowIso,
      updatedAt: nowIso
    };
    this.users.set(user.id, user);
    this.byEmail.set(email, user);
    this.#save();
    return user;
  }

  authenticate(email, password) {
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const user = normalizedEmail ? this.byEmail.get(normalizedEmail) : null;
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new UserError('AUTH_DENIED', 'Invalid email or password.', 401);
    }
    return user;
  }

  getById(id) {
    return typeof id === 'string' ? this.users.get(id) || null : null;
  }

  updateBusiness(userId, rawBusiness) {
    const user = this.getById(userId);
    if (!user) throw new UserError('NOT_FOUND', 'User account not found.', 404);
    let nextBusiness;
    try {
      nextBusiness = normalizeBusinessInput(rawBusiness, user.business);
    } catch (error) {
      throw new UserError('INVALID_ARGUMENTS', error.message, 400);
    }
    user.business = nextBusiness;
    user.profileCompleted = true;
    user.updatedAt = new Date().toISOString();
    this.#save();
    return user;
  }

  addBooking(userId, booking) {
    const user = this.getById(userId);
    if (!user) throw new UserError('NOT_FOUND', 'User account not found.', 404);
    user.bookings.push(booking);
    user.updatedAt = new Date().toISOString();
    this.#save();
    return booking;
  }

  removeBooking(userId, bookingId) {
    const user = this.getById(userId);
    if (!user) throw new UserError('NOT_FOUND', 'User account not found.', 404);
    const idx = user.bookings.findIndex(b => b.id === bookingId);
    if (idx === -1) return false;
    user.bookings.splice(idx, 1);
    user.updatedAt = new Date().toISOString();
    this.#save();
    return true;
  }
}

