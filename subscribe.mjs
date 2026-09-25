import { canonicalPageURL, validatedCheckoutURL } from './checkout.mjs';

const PRODUCTION_SUPABASE_URL = 'https://kjgskmhpqqrsejxhbofn.supabase.co';

export function isPublicSupabaseKey(key) {
  if (typeof key !== 'string') return false;
  if (/^sb_publishable_[a-zA-Z0-9_-]+$/.test(key)) return true;
  // Legacy public keys are JWTs with the anon role, never privileged roles.
  try {
    const parts = key.split('.');
    if (parts.length !== 3 || !parts.every(part => /^[a-zA-Z0-9_-]+$/.test(part))) return false;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload)).role === 'anon';
  } catch {
    return false;
  }
}

async function startSubscribe() {
  const forms = {
    email: document.getElementById('email-form'),
    code: document.getElementById('code-form'),
    purchase: document.getElementById('purchase-form'),
  };
  const emailInput = document.getElementById('email');
  const codeInput = document.getElementById('code');
  const status = document.getElementById('subscribe-status');
  const title = document.getElementById('signin-title');
  const stepLabel = document.getElementById('step-label');
  const accountEmail = document.getElementById('account-email');
  const emailButton = document.getElementById('email-submit');
  const codeButton = document.getElementById('code-submit');
  const purchaseButton = document.getElementById('purchase-submit');
  const resendButton = document.getElementById('resend-code');
  const changeButton = document.getElementById('change-email');
  const signOutButton = document.getElementById('sign-out');
  let config;
  let configured = false;
  let enabled = false;
  let busy = false;
  let stage = 'email';
  let email = '';
  let accessToken = '';
  let expiresAt = 0;
  let requestKey = '';
  let generation = 0;
  let controller;
  let nextEmailAt = 0;
  let resendTimer;

  function show(message) { status.textContent = message; }

  function render() {
    for (const [name, form] of Object.entries(forms)) {
      form.hidden = name !== stage;
      form.querySelector('fieldset').disabled = !enabled || busy || name !== stage;
      form.setAttribute('aria-busy', String(busy && name === stage));
    }
    emailInput.readOnly = Boolean(requestKey);
    changeButton.hidden = Boolean(requestKey);
    signOutButton.hidden = Boolean(requestKey);
    resendButton.disabled = busy || Date.now() < nextEmailAt;
    emailButton.textContent = busy && stage === 'email' ? 'Sending code...' : 'Send sign-in code';
    codeButton.textContent = busy && stage === 'code' ? 'Please wait...' : 'Verify code';
    purchaseButton.textContent = busy && stage === 'purchase' ? 'Preparing checkout...' : requestKey ? 'Retry the same checkout request' : 'Continue to secure checkout';
    const steps = {
      email: ['Step 1 of 3 / Your email', 'Sign in to continue'],
      code: ['Step 2 of 3 / Verify email', 'Check your inbox'],
      purchase: ['Step 3 of 3 / Review and continue', 'Ready when you are'],
    };
    [stepLabel.textContent, title.textContent] = steps[stage];
  }

  function setStage(next) {
    stage = next;
    render();
    title.focus();
  }

  async function post(path, body, authenticated = false) {
    controller = new AbortController();
    const activeController = controller;
    const timer = setTimeout(() => activeController.abort(), 20000);
    try {
      const response = await fetch(`${PRODUCTION_SUPABASE_URL}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: config.SUPABASE_PUBLIC_KEY,
          ...(authenticated ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: activeController.signal,
      });
      const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
      return { response, data };
    } finally {
      clearTimeout(timer);
      if (controller === activeController) controller = undefined;
    }
  }

  async function run(action, failureMessage) {
    if (!enabled || busy) return;
    const current = generation;
    busy = true;
    render();
    try {
      await action(() => current === generation);
    } catch {
      if (current === generation) show(failureMessage);
    } finally {
      if (current === generation) {
        busy = false;
        render();
      }
    }
  }

  function emailCooldown() {
    nextEmailAt = Date.now() + 60000;
    clearTimeout(resendTimer);
    resendTimer = setTimeout(render, 60000);
  }

  async function sendCode(isCurrent) {
    show('Sending a sign-in code. This does not start a subscription.');
    emailCooldown();
    const { response } = await post('/auth/v1/otp', { email, create_user: true });
    if (!isCurrent()) return;
    if (!response.ok) {
      show(response.status === 429 ? 'Please wait at least a minute before requesting another code.' : 'We could not send a code. Check your email address and try again later, or contact support.');
      return;
    }
    codeInput.value = '';
    setStage('code');
    show('Enter the full verification code from your email. Check your spam folder too. You can request another code after one minute.');
  }

  forms.email.addEventListener('submit', event => {
    event.preventDefault();
    if (busy || !enabled || stage !== 'email' || !forms.email.reportValidity()) return;
    if (Date.now() < nextEmailAt) {
      show('Please wait at least a minute before requesting another code.');
      return;
    }
    if (!requestKey) email = emailInput.value.trim();
    void run(sendCode, 'We could not confirm that a code was sent. Check your inbox first, then wait a minute before trying again.');
  });

  resendButton.addEventListener('click', () => {
    if (stage !== 'code' || Date.now() < nextEmailAt) return;
    void run(sendCode, 'We could not confirm that a new code was sent. Check your inbox before trying again.');
  });

  forms.code.addEventListener('submit', event => {
    event.preventDefault();
    if (stage !== 'code' || !forms.code.reportValidity()) return;
    void run(async isCurrent => {
      const token = codeInput.value.trim();
      codeInput.value = '';
      if (!/^[0-9]{6,10}$/.test(token)) {
        show('Enter the full verification code from your email.');
        return;
      }
      show('Verifying your sign-in code...');
      const { response, data } = await post('/auth/v1/verify', { email, token, type: 'email' });
      if (!isCurrent()) return;
      if (!response.ok || typeof data?.access_token !== 'string' || !data.access_token
          || !Number.isFinite(data.expires_in) || data.expires_in <= 30) {
        show(response.status === 429 ? 'Too many attempts. Wait a minute before trying again.' : 'The code could not be verified. Check the code or request a new one after one minute.');
        return;
      }
      accessToken = data.access_token;
      expiresAt = Date.now() + (data.expires_in - 30) * 1000;
      accountEmail.textContent = email;
      setStage('purchase');
      show('Email verified. No payment has been made. Continue only when you are ready to review the checkout.');
    }, 'Sign-in could not be verified. Please try again or request a new code.');
  });

  function requireSignIn() {
    accessToken = '';
    expiresAt = 0;
    emailInput.value = email;
    setStage('email');
    show('Your sign-in expired. Sign in again with the same email. Any existing checkout request will be reused, not replaced.');
  }

  forms.purchase.addEventListener('submit', event => {
    event.preventDefault();
    if (stage !== 'purchase' || busy || !enabled) return;
    if (!accessToken || Date.now() >= expiresAt) {
      requireSignIn();
      return;
    }
    void run(async isCurrent => {
      // Retain the key after every ambiguous response, timeout, and sign-in refresh.
      requestKey ||= crypto.randomUUID();
      render();
      show('Preparing your checkout. Keep this page open; this action does not charge you.');
      const { response, data } = await post('/functions/v1/paddle-checkout', { request_key: requestKey }, true);
      if (!isCurrent()) return;
      if (data?.result === 'existing_subscription') {
        enabled = false;
        accessToken = '';
        show('This account already has Pro access or a subscription. Do not buy another one. Use the billing provider shown on your existing receipt, or contact support if access was granted manually or you need help moving from Lemon Squeezy.');
        return;
      }
      if (data?.result === 'disabled' || data?.result === 'checkout_disabled') {
        enabled = false;
        accessToken = '';
        show('New checkouts are currently disabled. Please try again later or contact support. This page cannot confirm payment or activation.');
        return;
      }
      if (response.status === 401) {
        requireSignIn();
        return;
      }
      const checkoutURL = response.ok ? validatedCheckoutURL(data) : null;
      if (!checkoutURL) {
        show('Checkout could not be confirmed. Keep this page open and do not start a separate purchase. Wait, then retry this same request or contact support.');
        return;
      }
      enabled = false;
      accessToken = '';
      show('Opening Paddle so you can review and confirm payment.');
      window.location.assign(checkoutURL);
    }, 'We could not confirm the checkout request. Keep this page open. Retry here to reuse the same request, or contact support; do not start a separate purchase.');
  });

  function clearSession() {
    generation += 1;
    controller?.abort();
    clearTimeout(resendTimer);
    email = '';
    accessToken = '';
    expiresAt = 0;
    requestKey = '';
    enabled = configured;
    busy = false;
    emailInput.value = '';
    codeInput.value = '';
    accountEmail.textContent = '';
    stage = 'email';
    render();
  }

  for (const button of [changeButton, signOutButton]) {
    button.addEventListener('click', () => {
      if (busy || requestKey) return;
      clearSession();
      title.focus();
      show('Enter the email you use for the extension. Signing in does not start a subscription.');
    });
  }
  window.addEventListener('pagehide', clearSession);
  window.addEventListener('pageshow', event => {
    if (event.persisted) show('For your privacy, your session was cleared when you left. Sign in again if needed. If you submitted payment, check your receipt or contact support before starting another checkout.');
  });

  const canonical = canonicalPageURL(window.location.href, 'subscribe');
  if (!canonical || window.top !== window.self) {
    show('This address cannot be used for sign-in. Open https://www.autoeverythingflow.com/subscribe.html directly, without extra parameters.');
    return;
  }
  if (window.location.href !== canonical) {
    window.location.replace(canonical);
    return;
  }
  try {
    config = await import('./billing-config.mjs');
  } catch {
    show('Subscriptions are unavailable right now. Please try again later or contact support. No sign-in or payment request was sent.');
    return;
  }
  if (config.CHECKOUT_ENABLED !== true || config.SUPABASE_URL !== PRODUCTION_SUPABASE_URL
      || !isPublicSupabaseKey(config.SUPABASE_PUBLIC_KEY)) {
    show('New subscriptions are currently unavailable. Please try again later or contact support. No sign-in or payment request was sent.');
    return;
  }
  configured = true;
  enabled = true;
  render();
  show('Sign in first, then review your checkout. You will only pay when you confirm payment in Paddle.');
}

if (typeof document !== 'undefined' && document.body?.dataset.billingPage === 'subscribe') {
  void startSubscribe();
}
