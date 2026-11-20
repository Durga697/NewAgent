import { csrfHeaders, setCsrfToken } from './security.js';

const CURRENCIES = [
  ['INR', 'INR — Indian Rupee (₹)', 'en-IN'],
  ['USD', 'USD — US Dollar ($)', 'en-US'],
  ['GBP', 'GBP — British Pound (£)', 'en-GB'],
  ['EUR', 'EUR — Euro (€)', 'de-DE'],
  ['AUD', 'AUD — Australian Dollar (A$)', 'en-AU'],
  ['CAD', 'CAD — Canadian Dollar (C$)', 'en-CA'],
  ['SGD', 'SGD — Singapore Dollar (S$)', 'en-SG'],
  ['AED', 'AED — UAE Dirham', 'en-AE']
];

const LOCALES = [
  ['en-IN', 'English (India) · en-IN'],
  ['en-US', 'English (US) · en-US'],
  ['en-GB', 'English (UK) · en-GB'],
  ['en-AU', 'English (Australia) · en-AU'],
  ['en-CA', 'English (Canada) · en-CA'],
  ['en-SG', 'English (Singapore) · en-SG'],
  ['en-AE', 'English (UAE) · en-AE'],
  ['de-DE', 'German / Euro · de-DE'],
  ['fr-FR', 'French / Euro · fr-FR']
];

const TIMEZONES = [
  'Asia/Kolkata',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC'
];

const WEEKDAYS = [
  [0, 'Sun'],
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat']
];

let instanceCounter = 0;

export function formatPrice(amount, biz) {
  const locale = biz?.locale || 'en-IN';
  const currency = biz?.currency || 'INR';
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

export function effectiveServiceContact(service, biz) {
  const hasInfo = (c) => Boolean(c && (c.name || c.phone || c.email));
  if (hasInfo(service?.contact)) return service.contact;
  if (hasInfo(biz?.contact)) return biz.contact;
  return null;
}

export function formatContactParts(contact) {
  if (!contact) return [];
  return [contact.name, contact.role, contact.phone, contact.email].filter(Boolean);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'className') node.className = v;
    else if (k === 'textContent') node.textContent = v;
    else if (k in node && k !== 'list' && k !== 'for') node[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child !== undefined && child !== null && child !== false) node.append(child);
  }
  return node;
}

async function apiRequest(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...csrfHeaders(),
      ...options.headers
    }
  });
  let body = {};
  try {
    body = await res.json();
  } catch {}
  if (!res.ok) {
    throw new Error(body.error?.message || body.error || 'Request failed. Please try again.');
  }
  return body;
}

export function mountBusinessEditor(container, { getState, onStateChange, mode = 'desk' }) {
  const uid = `biz-${++instanceCounter}`;
  let authTab = 'register';
  let draft = null;
  let lastUserId = null;
  let lastUpdatedAt = null;
  let statusMessage = { kind: '', text: '' };
  let busy = false;

  function syncDraftFromState(force = false) {
    const state = getState();
    const user = state?.user || null;
    if (!user) {
      draft = null;
      lastUserId = null;
      lastUpdatedAt = null;
      return;
    }
    if (force || !draft || lastUserId !== user.id || lastUpdatedAt !== user.updatedAt) {
      draft = structuredClone(state.business);
      lastUserId = user.id;
      lastUpdatedAt = user.updatedAt;
    }
  }

  function makeField(id, labelText, inputProps = {}, hint = '') {
    const label = el('label', { for: id, textContent: labelText });
    const input = el('input', { id, ...inputProps });
    return el('div', { className: 'biz-field' }, [
      label,
      input,
      hint ? el('small', { className: 'biz-hint', textContent: hint }) : null
    ]);
  }

  function makeSelect(id, labelText, options, value) {
    const label = el('label', { for: id, textContent: labelText });
    const select = el('select', { id });
    const seen = new Set();
    for (const item of options) {
      const [optVal, optLabel] = Array.isArray(item) ? item : [item, item];
      seen.add(optVal);
      select.append(el('option', { value: optVal, textContent: optLabel }));
    }
    if (value && !seen.has(value)) {
      select.append(el('option', { value, textContent: value }));
    }
    select.value = value || '';
    return el('div', { className: 'biz-field' }, [label, select]);
  }

  function setStatus(kind, text) {
    statusMessage = { kind, text };
    const banner = container.querySelector('[data-biz-status]');
    if (!banner) return;
    banner.textContent = text;
    banner.className = kind ? `biz-status biz-status-${kind}` : 'biz-status hidden';
    banner.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    banner.hidden = !text;
  }

  function renderStatusNode() {
    const node = el('p', {
      className: statusMessage.text ? `biz-status biz-status-${statusMessage.kind || 'info'}` : 'biz-status hidden',
      textContent: statusMessage.text || '',
      hidden: !statusMessage.text
    });
    node.dataset.bizStatus = '1';
    node.setAttribute('role', statusMessage.kind === 'error' ? 'alert' : 'status');
    return node;
  }

  function renderSignedOut() {
    container.replaceChildren();
    const wrap = el('div', { className: `biz-editor biz-mode-${mode}` });
    const head = el('div', { className: 'biz-head' }, [
      el('div', {}, [
        el('p', { className: 'biz-eyebrow', textContent: 'USER ACCOUNT & COMPANY SETUP' }),
        el('h2', { textContent: 'Set up your own company, services & contacts' }),
        el('p', {
          className: 'biz-subtle',
          textContent: 'Create an account or sign in to enter your company name, address, service prices, and personal contacts for each service.'
        })
      ])
    ]);

    const tabs = el('div', { className: 'biz-tabs', role: 'group', 'aria-label': 'Account mode' });
    const regTab = el('button', {
      type: 'button',
      className: authTab === 'register' ? 'biz-tab active' : 'biz-tab',
      textContent: 'Create account'
    });
    regTab.setAttribute('aria-pressed', String(authTab === 'register'));
    regTab.onclick = () => {
      authTab = 'register';
      statusMessage = { kind: '', text: '' };
      render();
    };
    const loginTab = el('button', {
      type: 'button',
      className: authTab === 'login' ? 'biz-tab active' : 'biz-tab',
      textContent: 'Sign in'
    });
    loginTab.setAttribute('aria-pressed', String(authTab === 'login'));
    loginTab.onclick = () => {
      authTab = 'login';
      statusMessage = { kind: '', text: '' };
      render();
    };
    tabs.append(regTab, loginTab);

    const form = el('form', { className: 'biz-auth-form' });
    if (authTab === 'register') {
      const grid = el('div', { className: 'biz-grid' }, [
        makeField(`${uid}-reg-name`, 'Your full name', {
          name: 'fullName',
          required: true,
          maxLength: 100,
          autoComplete: 'name',
          placeholder: 'e.g., Priya Sharma'
        }),
        makeField(`${uid}-reg-email`, 'Account email', {
          name: 'email',
          type: 'email',
          required: true,
          maxLength: 160,
          autoComplete: 'email',
          placeholder: 'you@company.com'
        }),
        makeField(`${uid}-reg-pass`, 'Password (8+ characters)', {
          name: 'password',
          type: 'password',
          required: true,
          minLength: 8,
          maxLength: 128,
          autoComplete: 'new-password',
          placeholder: 'At least 8 characters'
        }),
        makeField(`${uid}-reg-biz-name`, 'Company name', {
          name: 'companyName',
          required: true,
          maxLength: 120,
          placeholder: 'e.g., Brightleaf Wellness'
        }),
        makeField(`${uid}-reg-biz-address`, 'Company address', {
          name: 'companyAddress',
          required: true,
          maxLength: 300,
          placeholder: 'Street, city, state / postal code'
        }),
        makeField(`${uid}-reg-biz-phone`, 'Primary contact phone (optional)', {
          name: 'companyPhone',
          type: 'tel',
          maxLength: 40,
          placeholder: '+91 98765 43210'
        })
      ]);
      const submit = el('button', {
        type: 'submit',
        className: 'biz-primary',
        textContent: busy ? 'Creating account…' : 'Create account & continue',
        disabled: busy
      });
      form.append(grid, el('div', { className: 'biz-actions' }, submit));
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (busy) return;
        const fd = new FormData(form);
        const fullName = String(fd.get('fullName') || '').trim();
        const email = String(fd.get('email') || '').trim();
        const password = String(fd.get('password') || '');
        const companyName = String(fd.get('companyName') || '').trim();
        const companyAddress = String(fd.get('companyAddress') || '').trim();
        const companyPhone = String(fd.get('companyPhone') || '').trim();
        busy = true;
        setStatus('', '');
        submit.disabled = true;
        try {
          const contact = { name: fullName, email };
          if (companyPhone) contact.phone = companyPhone;
          const nextState = await apiRequest('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({
              fullName,
              email,
              password,
              business: { name: companyName, address: companyAddress, contact }
            })
          });
          setCsrfToken(nextState.csrfToken);
          statusMessage = {
            kind: 'success',
            text: 'Account created! Now enter your services, prices, and personal contacts below, then click Save.'
          };
          busy = false;
          await onStateChange(nextState);
          syncDraftFromState(true);
          render();
        } catch (err) {
          busy = false;
          submit.disabled = false;
          setStatus('error', err.message);
        }
      };
    } else {
      const grid = el('div', { className: 'biz-grid' }, [
        makeField(`${uid}-login-email`, 'Account email', {
          name: 'email',
          type: 'email',
          required: true,
          maxLength: 160,
          autoComplete: 'email',
          placeholder: 'you@company.com'
        }),
        makeField(`${uid}-login-pass`, 'Password', {
          name: 'password',
          type: 'password',
          required: true,
          maxLength: 128,
          autoComplete: 'current-password',
          placeholder: 'Your password'
        })
      ]);
      const submit = el('button', {
        type: 'submit',
        className: 'biz-primary',
        textContent: busy ? 'Signing in…' : 'Sign in',
        disabled: busy
      });
      form.append(grid, el('div', { className: 'biz-actions' }, submit));
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (busy) return;
        const fd = new FormData(form);
        busy = true;
        setStatus('', '');
        submit.disabled = true;
        try {
          const nextState = await apiRequest('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({
              email: String(fd.get('email') || '').trim(),
              password: String(fd.get('password') || '')
            })
          });
          setCsrfToken(nextState.csrfToken);
          statusMessage = { kind: 'success', text: `Signed in as ${nextState.user.fullName}.` };
          busy = false;
          await onStateChange(nextState);
          syncDraftFromState(true);
          render();
        } catch (err) {
          busy = false;
          submit.disabled = false;
          setStatus('error', err.message);
        }
      };
    }

    wrap.append(head, tabs, renderStatusNode(), form);
    container.append(wrap);
  }

  function readDraftFromDom(form) {
    if (!draft || !form) return draft;
    const prevCurrency = draft.currency;
    draft.name = form.querySelector(`[data-field="biz-name"]`).value;
    draft.tagline = form.querySelector(`[data-field="biz-tagline"]`).value;
    draft.address = form.querySelector(`[data-field="biz-address"]`).value;
    draft.currency = form.querySelector(`[data-field="biz-currency"]`).value;
    draft.locale = form.querySelector(`[data-field="biz-locale"]`).value;
    draft.timezone = form.querySelector(`[data-field="biz-timezone"]`).value;

    const matchPrev = CURRENCIES.find(([code]) => code === prevCurrency);
    const matchNext = CURRENCIES.find(([code]) => code === draft.currency);
    if (prevCurrency !== draft.currency && matchPrev && matchNext && draft.locale === matchPrev[2]) {
      draft.locale = matchNext[2];
    }

    draft.contact = {
      name: form.querySelector(`[data-field="contact-name"]`).value,
      phone: form.querySelector(`[data-field="contact-phone"]`).value,
      email: form.querySelector(`[data-field="contact-email"]`).value
    };

    const opensAt = form.querySelector(`[data-field="cal-opens"]`).value;
    const closesAt = form.querySelector(`[data-field="cal-closes"]`).value;
    const slotMinutes = Number(form.querySelector(`[data-field="cal-slot"]`).value);
    const bookingWindowDays = Number(form.querySelector(`[data-field="cal-window"]`).value);
    const openWeekdays = [...form.querySelectorAll('[data-weekday]')].filter((cb) => cb.checked).map((cb) => Number(cb.dataset.weekday));
    draft.calendar = {
      ...draft.calendar,
      opensAt,
      closesAt,
      slotMinutes,
      bookingWindowDays,
      openWeekdays
    };

    const rows = [...form.querySelectorAll('[data-service-index]')];
    draft.services = rows.map((row, idx) => {
      const existing = draft.services[idx] || {};
      return {
        id: existing.id || '',
        name: row.querySelector('[data-svc="name"]').value,
        price: row.querySelector('[data-svc="price"]').value,
        minutes: row.querySelector('[data-svc="minutes"]').value,
        description: row.querySelector('[data-svc="description"]').value,
        contact: {
          name: row.querySelector('[data-svc="contact-name"]').value,
          role: row.querySelector('[data-svc="contact-role"]').value,
          phone: row.querySelector('[data-svc="contact-phone"]').value,
          email: row.querySelector('[data-svc="contact-email"]').value
        }
      };
    });
    return draft;
  }

  function renderSignedIn() {
    syncDraftFromState(false);
    const state = getState();
    const user = state.user;
    container.replaceChildren();

    const wrap = el('div', { className: `biz-editor biz-mode-${mode}` });
    const signOutBtn = el('button', {
      type: 'button',
      className: 'biz-secondary',
      textContent: 'Sign out',
      disabled: busy
    });
    signOutBtn.onclick = async () => {
      if (busy) return;
      busy = true;
      try {
        const nextState = await apiRequest('/api/auth/logout', { method: 'POST', body: '{}' });
        setCsrfToken(nextState.csrfToken);
        draft = null;
        lastUserId = null;
        lastUpdatedAt = null;
        statusMessage = { kind: 'info', text: 'Signed out.' };
        busy = false;
        await onStateChange(nextState);
        render();
      } catch (err) {
        busy = false;
        setStatus('error', err.message);
      }
    };

    const banner = el('div', { className: 'biz-account-banner' }, [
      el('div', {}, [
        el('p', { className: 'biz-eyebrow', textContent: 'SIGNED IN ACCOUNT' }),
        el('strong', { textContent: `${user.fullName} · ${user.email}` }),
        el('span', {
          className: 'biz-badge',
          textContent: user.profileCompleted ? 'Company profile active' : 'Finish setting up your company'
        })
      ]),
      signOutBtn
    ]);

    const form = el('form', { className: 'biz-form' });

    // Section 1: Company details
    const companySet = el('fieldset', { className: 'biz-fieldset' }, [
      el('legend', { textContent: 'Company details' })
    ]);
    const nameField = makeField(`${uid}-biz-name`, 'Company name', {
      required: true,
      maxLength: 120,
      value: draft.name || '',
      placeholder: 'Your company or studio name'
    });
    nameField.querySelector('input').dataset.field = 'biz-name';

    const taglineField = makeField(`${uid}-biz-tagline`, 'Tagline', {
      maxLength: 200,
      value: draft.tagline || '',
      placeholder: 'What your company offers'
    });
    taglineField.querySelector('input').dataset.field = 'biz-tagline';

    const addressField = makeField(`${uid}-biz-address`, 'Company address', {
      required: true,
      maxLength: 300,
      value: draft.address || '',
      placeholder: 'Full street address, city, postal code'
    });
    addressField.querySelector('input').dataset.field = 'biz-address';

    const currencyField = makeSelect(`${uid}-biz-currency`, 'Currency', CURRENCIES, draft.currency);
    const currencySelect = currencyField.querySelector('select');
    currencySelect.dataset.field = 'biz-currency';

    const localeField = makeSelect(`${uid}-biz-locale`, 'Number & date locale', LOCALES, draft.locale);
    const localeSelect = localeField.querySelector('select');
    localeSelect.dataset.field = 'biz-locale';

    currencySelect.addEventListener('change', () => {
      const match = CURRENCIES.find(([code]) => code === currencySelect.value);
      if (match) localeSelect.value = match[2];
    });

    const tzField = makeSelect(`${uid}-biz-tz`, 'Timezone', TIMEZONES, draft.timezone);
    tzField.querySelector('select').dataset.field = 'biz-timezone';

    companySet.append(
      el('div', { className: 'biz-grid' }, [
        nameField,
        taglineField,
        addressField,
        currencyField,
        localeField,
        tzField
      ])
    );

    // Section 2: Primary company contact
    const contactSet = el('fieldset', { className: 'biz-fieldset' }, [
      el('legend', { textContent: 'Company primary contact' })
    ]);
    const cName = makeField(`${uid}-c-name`, 'Primary contact name', {
      maxLength: 120,
      value: draft.contact?.name || '',
      placeholder: 'Owner or reception contact'
    });
    cName.querySelector('input').dataset.field = 'contact-name';
    const cPhone = makeField(`${uid}-c-phone`, 'Primary phone number', {
      type: 'tel',
      maxLength: 40,
      value: draft.contact?.phone || '',
      placeholder: '+91 98765 43210'
    });
    cPhone.querySelector('input').dataset.field = 'contact-phone';
    const cEmail = makeField(`${uid}-c-email`, 'Primary contact email', {
      type: 'email',
      maxLength: 160,
      value: draft.contact?.email || '',
      placeholder: 'hello@company.com'
    });
    cEmail.querySelector('input').dataset.field = 'contact-email';
    contactSet.append(el('div', { className: 'biz-grid biz-grid-3' }, [cName, cPhone, cEmail]));

    // Section 3: Services, prices & personal contacts
    const servicesSet = el('fieldset', { className: 'biz-fieldset' }, [
      el('legend', { textContent: 'Services, prices & personal contacts' }),
      el('p', {
        className: 'biz-subtle',
        textContent: 'Enter each service, its price, duration, and the personal contact assigned to handle that service.'
      })
    ]);
    const servicesList = el('div', { className: 'biz-services-list' });

    draft.services.forEach((svc, idx) => {
      const card = el('div', { className: 'biz-service-item' });
      card.dataset.serviceIndex = String(idx);

      const removeBtn = el('button', {
        type: 'button',
        className: 'biz-remove',
        textContent: 'Remove service',
        disabled: draft.services.length <= 1
      });
      removeBtn.onclick = () => {
        if (draft.services.length <= 1) return;
        readDraftFromDom(form);
        draft.services.splice(idx, 1);
        render();
      };

      const itemHead = el('div', { className: 'biz-service-head' }, [
        el('strong', { textContent: `Service ${idx + 1}` }),
        removeBtn
      ]);

      const sName = makeField(`${uid}-svc-${idx}-name`, 'Service name', {
        required: true,
        maxLength: 120,
        value: svc.name || '',
        placeholder: 'e.g., Tax advisory session'
      });
      sName.querySelector('input').dataset.svc = 'name';

      const sPrice = makeField(`${uid}-svc-${idx}-price`, `Price (${draft.currency || 'INR'})`, {
        type: 'number',
        min: '0',
        step: 'any',
        required: true,
        value: svc.price ?? 0
      });
      sPrice.querySelector('input').dataset.svc = 'price';

      const sMinutes = makeField(`${uid}-svc-${idx}-min`, 'Duration (minutes)', {
        type: 'number',
        min: '5',
        max: '1440',
        step: '5',
        required: true,
        value: svc.minutes ?? 30
      });
      sMinutes.querySelector('input').dataset.svc = 'minutes';

      const sDesc = makeField(`${uid}-svc-${idx}-desc`, 'Description (optional)', {
        maxLength: 300,
        value: svc.description || '',
        placeholder: 'What is included in this service?'
      });
      sDesc.querySelector('input').dataset.svc = 'description';

      const contactSub = el('div', { className: 'biz-subcontact' }, [
        el('p', { className: 'biz-subcontact-title', textContent: 'Personal contact for this service' })
      ]);
      const scName = makeField(`${uid}-svc-${idx}-cname`, 'Contact person name', {
        maxLength: 120,
        value: svc.contact?.name || '',
        placeholder: 'e.g., Ananya Rao'
      });
      scName.querySelector('input').dataset.svc = 'contact-name';

      const scRole = makeField(`${uid}-svc-${idx}-crole`, 'Role or title (optional)', {
        maxLength: 80,
        value: svc.contact?.role || '',
        placeholder: 'e.g., Senior Specialist'
      });
      scRole.querySelector('input').dataset.svc = 'contact-role';

      const scPhone = makeField(`${uid}-svc-${idx}-cphone`, 'Personal phone', {
        type: 'tel',
        maxLength: 40,
        value: svc.contact?.phone || '',
        placeholder: '+91 98111 22334'
      });
      scPhone.querySelector('input').dataset.svc = 'contact-phone';

      const scEmail = makeField(`${uid}-svc-${idx}-cemail`, 'Personal email', {
        type: 'email',
        maxLength: 160,
        value: svc.contact?.email || '',
        placeholder: 'ananya@company.com'
      });
      scEmail.querySelector('input').dataset.svc = 'contact-email';

      contactSub.append(el('div', { className: 'biz-grid biz-grid-2' }, [scName, scRole, scPhone, scEmail]));

      card.append(
        itemHead,
        el('div', { className: 'biz-grid biz-grid-2' }, [sName, sPrice, sMinutes, sDesc]),
        contactSub
      );
      servicesList.append(card);
    });

    const addBtn = el('button', {
      type: 'button',
      className: 'biz-secondary biz-add-service',
      textContent: '+ Add service'
    });
    addBtn.onclick = () => {
      readDraftFromDom(form);
      draft.services.push({
        id: '',
        name: '',
        minutes: 30,
        price: 0,
        description: '',
        contact: { name: '', role: '', phone: '', email: '' }
      });
      render();
      const inputs = container.querySelectorAll('[data-svc="name"]');
      inputs[inputs.length - 1]?.focus();
    };

    servicesSet.append(servicesList, addBtn);

    // Section 4: Business hours & schedule (collapsible)
    const scheduleDetails = el('details', { className: 'biz-schedule-details' }, [
      el('summary', { textContent: 'Business hours & booking schedule' })
    ]);
    const opensField = makeField(`${uid}-cal-opens`, 'Opens at', {
      type: 'time',
      required: true,
      value: draft.calendar?.opensAt || '09:00'
    });
    opensField.querySelector('input').dataset.field = 'cal-opens';

    const closesField = makeField(`${uid}-cal-closes`, 'Closes at', {
      type: 'time',
      required: true,
      value: draft.calendar?.closesAt || '18:00'
    });
    closesField.querySelector('input').dataset.field = 'cal-closes';

    const slotField = makeField(`${uid}-cal-slot`, 'Slot interval (minutes)', {
      type: 'number',
      min: '5',
      max: '240',
      required: true,
      value: draft.calendar?.slotMinutes ?? 30
    });
    slotField.querySelector('input').dataset.field = 'cal-slot';

    const windowField = makeField(`${uid}-cal-window`, 'Booking window (days)', {
      type: 'number',
      min: '1',
      max: '365',
      required: true,
      value: draft.calendar?.bookingWindowDays ?? 30
    });
    windowField.querySelector('input').dataset.field = 'cal-window';

    const daysSet = el('fieldset', { className: 'biz-weekdays' }, [
      el('legend', { textContent: 'Open days' })
    ]);
    const daysRow = el('div', { className: 'biz-weekdays-row' });
    const activeDays = new Set(draft.calendar?.openWeekdays || [1, 2, 3, 4, 5]);
    for (const [dayNum, dayLabel] of WEEKDAYS) {
      const cbId = `${uid}-day-${dayNum}`;
      const cb = el('input', { id: cbId, type: 'checkbox', checked: activeDays.has(dayNum) });
      cb.dataset.weekday = String(dayNum);
      daysRow.append(el('label', { className: 'biz-day-chip', for: cbId }, [cb, el('span', { textContent: dayLabel })]));
    }
    daysSet.append(daysRow);
    scheduleDetails.append(
      el('div', { className: 'biz-grid biz-grid-2' }, [opensField, closesField, slotField, windowField]),
      daysSet
    );

    const saveBtn = el('button', {
      type: 'submit',
      className: 'biz-primary',
      textContent: busy ? 'Saving…' : 'Save company & services',
      disabled: busy
    });
    const resetBtn = el('button', {
      type: 'button',
      className: 'biz-secondary',
      textContent: 'Reset changes',
      disabled: busy
    });
    resetBtn.onclick = () => {
      syncDraftFromState(true);
      statusMessage = { kind: 'info', text: 'Reverted unsaved edits.' };
      render();
    };

    form.append(
      companySet,
      contactSet,
      servicesSet,
      scheduleDetails,
      el('div', { className: 'biz-actions' }, [saveBtn, resetBtn])
    );

    form.onsubmit = async (event) => {
      event.preventDefault();
      if (busy) return;
      const payload = readDraftFromDom(form);
      if (!payload.calendar.openWeekdays.length) {
        setStatus('error', 'Select at least one open day for bookings.');
        return;
      }
      busy = true;
      setStatus('', '');
      saveBtn.disabled = true;
      try {
        const result = await apiRequest('/api/business', {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
        statusMessage = {
          kind: 'success',
          text: 'Company details, services, prices, and personal contacts saved.'
        };
        busy = false;
        await onStateChange(result);
        syncDraftFromState(true);
        render();
      } catch (err) {
        busy = false;
        saveBtn.disabled = false;
        setStatus('error', err.message);
      }
    };

    wrap.append(banner, renderStatusNode(), form);
    container.append(wrap);
  }

  function render() {
    const state = getState();
    if (!state) return;
    if (state.user) renderSignedIn();
    else renderSignedOut();
  }

  render();

  return {
    refresh(force = false) {
      if (force) syncDraftFromState(true);
      render();
    },
    openAuth(tab = 'login') {
      if (getState()?.user) return;
      authTab = tab === 'login' ? 'login' : 'register';
      statusMessage = { kind: '', text: '' };
      render();
      const target = container.querySelector('input');
      target?.focus();
    }
  };
}
