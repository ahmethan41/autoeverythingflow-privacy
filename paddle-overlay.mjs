import { validatedCheckoutURL } from './checkout.mjs';

const SUBSCRIBE_URL = 'https://www.autoeverythingflow.com/subscribe.html';
const validEmail = value => typeof value === 'string' && value.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// Receives only an already-bound transaction and verified email, never Auth tokens.
// A retry reopens this same transaction; this module cannot create a purchase.
export function createPaddleOverlay({ token, onState }) {
  let initialized = false;
  let loading;
  let session;
  let active = false;
  let generation = 0;
  let phase = 'idle';
  let paymentStarted = false;
  let completed = false;
  let watchTimer;

  function publish(next, message, canRetry = false) {
    phase = next;
    onState({ phase, message, canRetry: canRetry && !paymentStarted && !completed });
  }

  function attention() {
    if (!active || completed) return;
    clearTimeout(watchTimer);
    publish('attention', paymentStarted
      ? 'Payment status is not confirmed. Check your receipt or contact support before attempting another payment.'
      : 'Paddle needs attention. Check the payment window. Close it before reopening this same checkout.');
  }

  function eventCallback(event) {
    if (!active || completed) return;
    if (event?.data?.transaction_id && event.data.transaction_id !== session.transactionId) return;
    switch (event?.name) {
      case 'checkout.loaded':
        if (paymentStarted || phase === 'closed') return;
        clearTimeout(watchTimer);
        publish('open', 'Review your total in Paddle. You are charged only when you confirm payment there.');
        break;
      case 'checkout.payment.initiated':
        paymentStarted = true;
        clearTimeout(watchTimer);
        publish('processing', 'Paddle is processing your payment. Do not reload or submit another payment.');
        break;
      case 'checkout.completed':
        completed = true;
        clearTimeout(watchTimer);
        publish('completed', 'Payment submitted. Pro activation is verified server-side. Return to the extension to check your account; do not pay again while verification is pending.');
        break;
      case 'checkout.closed':
        clearTimeout(watchTimer);
        publish('closed', paymentStarted
          ? 'Payment status is not confirmed. Check your receipt or contact support before trying again.'
          : 'Checkout closed. You can reopen the same checkout below without another email code. If you submitted payment, check your receipt before trying again.', true);
        break;
      case 'checkout.error':
      case 'checkout.warning':
      case 'checkout.payment.error':
      case 'checkout.payment.failed':
        attention();
        break;
      default:
        // Informational/customer/discount events never unlock a pending payment.
        break;
    }
  }

  function loadSDK() {
    if (initialized) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
      script.async = true;
      script.referrerPolicy = 'no-referrer';
      let finished = false;
      const fail = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        script.remove();
        reject(Error('paddle_unavailable'));
      };
      const timer = setTimeout(fail, 20000);
      script.addEventListener('error', fail, { once: true });
      script.addEventListener('load', () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          window.Paddle.Initialize({ token, eventCallback, checkout: { settings: {
            displayMode: 'overlay', variant: 'one-page', allowLogout: false,
            allowDiscountRemoval: true, showAddDiscounts: true,
          } } });
          initialized = true;
          resolve();
        } catch { reject(Error('paddle_initialization_failed')); }
      }, { once: true });
      document.head.append(script);
    }).finally(() => { loading = undefined; });
    return loading;
  }

  return {
    async open(data, email) {
      if (!/^live_[a-zA-Z0-9_-]+$/.test(token) || window.location.href !== SUBSCRIBE_URL ||
          window.top !== window.self || !validatedCheckoutURL(data) || !validEmail(email) ||
          paymentStarted || completed || !['idle', 'closed', 'load_failed'].includes(phase)) return false;
      if (session && (data.transactionId !== session.transactionId || email !== session.email)) return false;
      session ??= { transactionId: data.transactionId, email };
      const current = ++generation;
      active = true;
      publish('loading', 'Opening Paddle with your email already filled in. No payment has been made.');
      try { await loadSDK(); }
      catch {
        if (active && current === generation) publish('load_failed', 'Paddle could not load. Reopen the same checkout below; no new sign-in code is needed.', true);
        return false;
      }
      if (!active || current !== generation || window.location.href !== SUBSCRIBE_URL) return false;
      watchTimer = setTimeout(attention, 20000);
      try {
        // subscribe.html has no _ptxn, so exactly one explicit open is needed.
        // No items array: the server-bound transaction owns product and pricing.
        window.Paddle.Checkout.open({ transactionId: session.transactionId,
          customer: { email: session.email } });
        return true;
      } catch { attention(); return false; }
    },
    reset() {
      active = false;
      generation += 1;
      clearTimeout(watchTimer);
      if (initialized) {
        try { window.Paddle.Checkout.close(); } catch { /* Page may already be leaving. */ }
      }
      session = undefined;
      phase = 'idle';
      paymentStarted = false;
      completed = false;
    },
  };
}
