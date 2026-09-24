const CANONICAL_ORIGIN = 'https://www.autoeverythingflow.com';
const TRANSACTION_ID = /^txn_[a-z0-9]{26}$/;

// Match the literal URL, not decoded query parameters or a normalized backend URL.
export function canonicalPageURL(href, page) {
  if (typeof href !== 'string' || !['checkout', 'subscribe'].includes(page)) return null;
  const suffix = page === 'checkout' ? String.raw`\?_ptxn=txn_[a-z0-9]{26}` : '';
  const pattern = new RegExp(`^https?://(?:www\\.)?autoeverythingflow\\.com/${page}\\.html${suffix}$`);
  const match = href.match(pattern);
  if (!match || match[0] !== href) return null;
  return `${CANONICAL_ORIGIN}/${page}.html${page === 'checkout' ? new URL(href).search : ''}`;
}

export function validatedCheckoutURL(data) {
  if (data?.result !== 'checkout_ready' || typeof data.transactionId !== 'string'
      || !TRANSACTION_ID.test(data.transactionId) || data.transactionId.length !== 30) return null;
  const expected = `${CANONICAL_ORIGIN}/checkout.html?_ptxn=${data.transactionId}`;
  return data.checkoutUrl === expected ? expected : null;
}

async function startCheckout() {
  const title = document.getElementById('checkout-status-title');
  const status = document.getElementById('checkout-status');
  const retry = document.getElementById('checkout-retry');
  const subscribeLink = document.getElementById('subscribe-link');
  let completed = false;
  let paymentStarted = false;
  let retryAllowed = false;
  let watchTimer;

  function show(heading, message, mayRetry = false) {
    title.textContent = heading;
    status.textContent = message;
    retryAllowed = mayRetry && !completed;
    retry.hidden = !retryAllowed;
  }

  const canonical = canonicalPageURL(window.location.href, 'checkout');
  if (!canonical || window.top !== window.self) {
    show('This checkout link cannot be used', 'Use the subscription page to sign in and request a secure checkout. No checkout was opened on this page.');
    return;
  }
  if (window.location.href !== canonical) {
    window.location.replace(canonical);
    return;
  }

  retry.addEventListener('click', () => {
    if (!retryAllowed || completed || window.location.href !== canonical) return;
    retry.disabled = true;
    // Only an explicit click retries; the identical transaction URL is retained.
    window.location.reload();
  });

  let config;
  try {
    config = await import('./billing-config.mjs');
  } catch {
    show('Checkout is unavailable', 'Checkout is not ready right now. Please try again later or contact support.');
    return;
  }
  if (config.CHECKOUT_ENABLED !== true || typeof config.PADDLE_CLIENT_TOKEN !== 'string'
      || !/^live_[a-zA-Z0-9_-]+$/.test(config.PADDLE_CLIENT_TOKEN)) {
    show('Checkout is unavailable', 'New payments are currently unavailable. Please try again later or contact support.');
    return;
  }

  function safeRetry(heading) {
    if (completed) return;
    clearTimeout(watchTimer);
    show(heading, paymentStarted
      ? 'Payment status has not been confirmed. Check your receipt or contact support before trying again. Do not reload or submit another payment while the outcome is unknown.'
      : 'Payment status has not been confirmed. If you already submitted payment, check your receipt or contact support before trying again. Otherwise, reload this same checkout when you are ready.', !paymentStarted);
  }

  function onCheckoutEvent(event) {
    if (completed) return;
    switch (event?.name) {
      case 'checkout.completed':
        completed = true;
        clearTimeout(watchTimer);
        subscribeLink.hidden = true;
        show('Payment submitted', 'Activation is verified server-side. This page does not confirm Pro access. Return to the extension to check your account, and do not submit another payment while verification is pending.');
        break;
      case 'checkout.loaded':
        if (paymentStarted) break;
        clearTimeout(watchTimer);
        show('Your checkout is open', 'Review the amount and billing details in Paddle. You will only pay when you confirm payment there.');
        break;
      case 'checkout.payment.initiated':
        paymentStarted = true;
        clearTimeout(watchTimer);
        subscribeLink.hidden = true;
        show('Payment is being processed', 'Please wait for Paddle to finish. Do not reload the checkout or submit another payment while the outcome is unknown.');
        break;
      case 'checkout.closed':
        safeRetry('Checkout closed');
        break;
      case 'checkout.error':
      case 'checkout.payment.error':
      case 'checkout.payment.failed':
      case 'checkout.warning':
        safeRetry('Checkout needs attention');
        break;
      case 'checkout.customer.created':
      case 'checkout.customer.removed':
      case 'checkout.customer.updated':
      case 'checkout.discount.applied':
      case 'checkout.discount.removed':
      case 'checkout.items.removed':
      case 'checkout.items.updated':
      case 'checkout.payment.selected':
      case 'checkout.updated':
        break;
      default:
        // New informational SDK events must not offer a retry during payment.
        break;
    }
  }

  show('Opening secure checkout', 'Please wait while Paddle loads your checkout. No payment is made by opening this page.');
  watchTimer = setTimeout(() => safeRetry('Checkout is taking longer than expected'), 20000);

  const script = document.createElement('script');
  script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
  script.async = true;
  script.referrerPolicy = 'no-referrer';
  script.addEventListener('error', () => safeRetry('Paddle could not be loaded'), { once: true });
  script.addEventListener('load', () => {
    // A late script load must not open a checkout after the URL has changed.
    if (window.location.href !== canonical || completed) return;
    try {
      // _ptxn opens the transaction automatically. Never open it a second time.
      window.Paddle.Initialize({
        token: config.PADDLE_CLIENT_TOKEN,
        eventCallback: onCheckoutEvent,
        checkout: {
          settings: { displayMode: 'overlay', allowLogout: false, allowDiscountRemoval: false, showAddDiscounts: false },
        },
      });
    } catch {
      safeRetry('Checkout could not be opened');
    }
  }, { once: true });
  document.head.append(script);
}

if (typeof document !== 'undefined' && document.body?.dataset.billingPage === 'checkout') {
  void startCheckout();
}
